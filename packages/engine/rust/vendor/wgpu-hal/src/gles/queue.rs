use alloc::sync::Arc;
use alloc::vec;
use alloc::vec::Vec;
use core::sync::atomic::Ordering;

use arrayvec::ArrayVec;
use glow::HasContext;

use super::{conv::is_layered_target, lock, Command as C, PrivateCapabilities};

const DEBUG_ID: u32 = 0;

// Drawpane: cap the complete-FBO LRU cache to keep GL object count bounded while covering
// the working set of tile, scope, mask, blur, and glass targets in one frame.
const MAX_CACHED_FBOS: usize = 64;

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum FboAttachmentKey {
    Renderbuffer(glow::Renderbuffer),
    Texture2D {
        raw: glow::Texture,
        target: u32,
        mip_level: i32,
        sample_count: u32,
    },
    TextureLayer {
        raw: glow::Texture,
        mip_level: i32,
        layer: i32,
    },
    #[cfg(webgl)]
    TextureMultiview {
        raw: glow::Texture,
        mip_level: i32,
        base_layer: i32,
        num_layers: i32,
    },
}

impl FboAttachmentKey {
    fn from_view(
        view: &super::TextureView,
        depth_slice: Option<u32>,
        sample_count: u32,
    ) -> Option<Self> {
        match view.inner {
            super::TextureInner::Renderbuffer { raw } => Some(Self::Renderbuffer(raw)),
            super::TextureInner::Texture { raw, target } => {
                let num_layers = view.array_layers.end - view.array_layers.start;
                if num_layers > 1 {
                    #[cfg(webgl)]
                    {
                        Some(Self::TextureMultiview {
                            raw,
                            mip_level: view.mip_levels.start as i32,
                            base_layer: view.array_layers.start as i32,
                            num_layers: num_layers as i32,
                        })
                    }
                    #[cfg(not(webgl))]
                    {
                        None
                    }
                } else if is_layered_target(target) {
                    let layer = if target == glow::TEXTURE_3D {
                        depth_slice.unwrap() as i32
                    } else {
                        view.array_layers.start as i32
                    };
                    Some(Self::TextureLayer {
                        raw,
                        mip_level: view.mip_levels.start as i32,
                        layer,
                    })
                } else {
                    assert_eq!(view.mip_levels.len(), 1);
                    Some(Self::Texture2D {
                        raw,
                        target: get_2d_target(target, view.array_layers.start),
                        mip_level: view.mip_levels.start as i32,
                        sample_count,
                    })
                }
            }
            super::TextureInner::DefaultRenderbuffer => None,
            #[cfg(webgl)]
            super::TextureInner::ExternalFramebuffer { .. } => None,
            #[cfg(native)]
            super::TextureInner::ExternalNativeFramebuffer { .. } => None,
        }
    }

    fn references_texture(self, texture: glow::Texture) -> bool {
        match self {
            Self::Renderbuffer(_) => false,
            Self::Texture2D { raw, .. } | Self::TextureLayer { raw, .. } => raw == texture,
            #[cfg(webgl)]
            Self::TextureMultiview { raw, .. } => raw == texture,
        }
    }

    fn references_renderbuffer(self, renderbuffer: glow::Renderbuffer) -> bool {
        matches!(self, Self::Renderbuffer(raw) if raw == renderbuffer)
    }

    unsafe fn attach(self, gl: &glow::Context, fbo_target: u32, attachment: u32) {
        match self {
            Self::Renderbuffer(raw) => unsafe {
                gl.framebuffer_renderbuffer(fbo_target, attachment, glow::RENDERBUFFER, Some(raw));
            },
            Self::Texture2D {
                raw,
                target,
                mip_level,
                sample_count,
            } => unsafe {
                if sample_count != 1 {
                    gl.framebuffer_texture_2d_multisample(
                        fbo_target,
                        attachment,
                        target,
                        Some(raw),
                        mip_level,
                        sample_count as i32,
                    );
                } else {
                    gl.framebuffer_texture_2d(
                        fbo_target,
                        attachment,
                        target,
                        Some(raw),
                        mip_level,
                    );
                }
            },
            Self::TextureLayer {
                raw,
                mip_level,
                layer,
            } => unsafe {
                gl.framebuffer_texture_layer(fbo_target, attachment, Some(raw), mip_level, layer);
            },
            #[cfg(webgl)]
            Self::TextureMultiview {
                raw,
                mip_level,
                base_layer,
                num_layers,
            } => unsafe {
                gl.framebuffer_texture_multiview_ovr(
                    fbo_target,
                    attachment,
                    Some(raw),
                    mip_level,
                    base_layer,
                    num_layers,
                );
            },
        }
    }
}

#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
struct FboKey {
    color: [Option<FboAttachmentKey>; crate::MAX_COLOR_ATTACHMENTS],
    depth_stencil: Option<(u32, FboAttachmentKey)>,
}

impl FboKey {
    fn references_texture(&self, texture: glow::Texture) -> bool {
        self.color
            .iter()
            .flatten()
            .any(|att| att.references_texture(texture))
            || self
                .depth_stencil
                .is_some_and(|(_, att)| att.references_texture(texture))
    }

    fn references_renderbuffer(&self, renderbuffer: glow::Renderbuffer) -> bool {
        self.color
            .iter()
            .flatten()
            .any(|att| att.references_renderbuffer(renderbuffer))
            || self
                .depth_stencil
                .is_some_and(|(_, att)| att.references_renderbuffer(renderbuffer))
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum FboSlotOp<T> {
    Detach(u32),
    Attach(u32, T),
}

// Drawpane: minimal slot diff between an FBO's previous attachment set and its new attachment
// set so evicted/reused FBOs only detach slots that are no longer used and only attach slots
// that changed.
fn diff_fbo_slots<T: Copy + PartialEq>(
    old_color: &[Option<T>; crate::MAX_COLOR_ATTACHMENTS],
    old_depth_stencil: Option<(u32, T)>,
    new_color: &[Option<T>; crate::MAX_COLOR_ATTACHMENTS],
    new_depth_stencil: Option<(u32, T)>,
    mut emit: impl FnMut(FboSlotOp<T>),
) {
    for i in 0..crate::MAX_COLOR_ATTACHMENTS {
        let slot = glow::COLOR_ATTACHMENT0 + i as u32;
        if old_color[i] == new_color[i] {
            continue;
        }
        match new_color[i] {
            Some(att) => emit(FboSlotOp::Attach(slot, att)),
            None => emit(FboSlotOp::Detach(slot)),
        }
    }
    if old_depth_stencil == new_depth_stencil {
        return;
    }
    match (old_depth_stencil, new_depth_stencil) {
        (Some((old_pt, _)), None) => emit(FboSlotOp::Detach(old_pt)),
        (None, Some((new_pt, att))) => emit(FboSlotOp::Attach(new_pt, att)),
        (Some((old_pt, _)), Some((new_pt, att))) => {
            if old_pt != new_pt {
                emit(FboSlotOp::Detach(glow::DEPTH_STENCIL_ATTACHMENT));
            }
            emit(FboSlotOp::Attach(new_pt, att));
        }
        (None, None) => {}
    }
}

#[derive(Debug)]
struct FboCacheEntry {
    fbo: glow::Framebuffer,
    key: FboKey,
    draw_buffer_count: Option<u8>,
}

/// Drawpane: LRU cache of complete draw FBOs on `AdapterShared`.
#[derive(Debug, Default)]
pub(super) struct FboCache {
    /// Most-recently-used entry at index 0.
    entries: Vec<FboCacheEntry>,
}

impl FboCache {
    unsafe fn acquire(
        &mut self,
        gl: &glow::Context,
        key: FboKey,
        currently_bound: DrawFboBinding,
    ) -> Option<(glow::Framebuffer, Option<u8>)> {
        if let Some(pos) = self.entries.iter().position(|e| e.key == key) {
            if pos > 0 {
                self.entries[..=pos].rotate_right(1);
            }
            let entry = &self.entries[0];
            if currently_bound != DrawFboBinding::Cached(entry.fbo) {
                unsafe { gl.bind_framebuffer(glow::DRAW_FRAMEBUFFER, Some(entry.fbo)) };
            }
            return Some((entry.fbo, entry.draw_buffer_count));
        }

        if self.entries.len() < MAX_CACHED_FBOS {
            if let Ok(fbo) = unsafe { gl.create_framebuffer() } {
                unsafe { gl.bind_framebuffer(glow::DRAW_FRAMEBUFFER, Some(fbo)) };
                let empty = FboKey::default();
                diff_fbo_slots(
                    &empty.color,
                    empty.depth_stencil,
                    &key.color,
                    key.depth_stencil,
                    |op| match op {
                        FboSlotOp::Detach(_) => unreachable!(),
                        FboSlotOp::Attach(slot, att) => unsafe {
                            att.attach(gl, glow::DRAW_FRAMEBUFFER, slot);
                        },
                    },
                );
                self.entries.insert(
                    0,
                    FboCacheEntry {
                        fbo,
                        key,
                        draw_buffer_count: None,
                    },
                );
                return Some((fbo, None));
            }
        }

        if self.entries.is_empty() {
            return None;
        }

        // Reuse the LRU entry (last element) by diffing only the attachments that changed.
        self.entries.rotate_right(1);
        let entry = &mut self.entries[0];
        if currently_bound != DrawFboBinding::Cached(entry.fbo) {
            unsafe { gl.bind_framebuffer(glow::DRAW_FRAMEBUFFER, Some(entry.fbo)) };
        }
        let old_key = entry.key;
        diff_fbo_slots(
            &old_key.color,
            old_key.depth_stencil,
            &key.color,
            key.depth_stencil,
            |op| match op {
                FboSlotOp::Detach(slot) => unsafe {
                    gl.framebuffer_texture_2d(
                        glow::DRAW_FRAMEBUFFER,
                        slot,
                        glow::TEXTURE_2D,
                        None,
                        0,
                    );
                },
                FboSlotOp::Attach(slot, att) => unsafe {
                    att.attach(gl, glow::DRAW_FRAMEBUFFER, slot);
                },
            },
        );
        entry.key = key;
        Some((entry.fbo, entry.draw_buffer_count))
    }

    fn set_draw_buffer_count(&mut self, fbo: glow::Framebuffer, count: u8) {
        if let Some(entry) = self.entries.iter_mut().find(|e| e.fbo == fbo) {
            entry.draw_buffer_count = Some(count);
        }
    }

    pub(super) unsafe fn invalidate_texture(&mut self, gl: &glow::Context, texture: glow::Texture) {
        self.entries.retain(|entry| {
            if entry.key.references_texture(texture) {
                unsafe { gl.delete_framebuffer(entry.fbo) };
                false
            } else {
                true
            }
        });
    }

    pub(super) unsafe fn invalidate_renderbuffer(
        &mut self,
        gl: &glow::Context,
        renderbuffer: glow::Renderbuffer,
    ) {
        self.entries.retain(|entry| {
            if entry.key.references_renderbuffer(renderbuffer) {
                unsafe { gl.delete_framebuffer(entry.fbo) };
                false
            } else {
                true
            }
        });
    }

    pub(super) unsafe fn destroy_all(&mut self, gl: &glow::Context) {
        for entry in self.entries.drain(..) {
            unsafe { gl.delete_framebuffer(entry.fbo) };
        }
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum DrawFboBinding {
    Default,
    Cached(glow::Framebuffer),
    Fallback,
    External,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum ReadFboBinding {
    Default,
    CopyFbo,
    Unknown,
}

/// Drawpane: per-submit GL shadow state, initialized once from `reset_state(gl)` on the first
/// non-empty command buffer and discarded when `Queue::submit` returns.
#[derive(Debug)]
struct SubmitState {
    program: Option<Option<glow::Program>>,
    draw_fbo: DrawFboBinding,
    read_fbo: ReadFboBinding,
    active_draw_fbo_draw_buffers: Option<u8>,
    depth_test: Option<bool>,
    stencil_test: Option<bool>,
    scissor_test: Option<bool>,
    scissor_rect: Option<[i32; 4]>,
    viewport: Option<[i32; 4]>,
    depth_range: Option<(u32, u32)>,
    primitive: Option<super::PrimitiveState>,
    cull_face_enabled: Option<bool>,
    depth_clamp: Option<bool>,
    polygon_offset_enabled: Option<bool>,
    alpha_to_coverage: Option<bool>,
    clip_distance_count: u32,
    color_mask_all_true: Option<bool>,
    depth_mask: Option<bool>,
    depth_func: Option<u32>,
    stencil_mask_all: Option<bool>,
    uniform_color_target: Option<super::ColorTargetDesc>,
    blend_all_disabled: bool,
    index_buffer: Option<glow::Buffer>,
    copy_fbo_attachment: Option<FboAttachmentKey>,
    copy_fbo_dirty: bool,
    active_texture: Option<u32>,
}

impl SubmitState {
    fn after_reset(has_depth_clip_control: bool) -> Self {
        Self {
            program: Some(None),
            draw_fbo: DrawFboBinding::Default,
            read_fbo: ReadFboBinding::Default,
            active_draw_fbo_draw_buffers: None,
            depth_test: Some(false),
            stencil_test: Some(false),
            scissor_test: Some(false),
            scissor_rect: None,
            viewport: None,
            depth_range: None,
            primitive: None,
            cull_face_enabled: Some(false),
            depth_clamp: has_depth_clip_control.then_some(false),
            polygon_offset_enabled: Some(false),
            alpha_to_coverage: Some(false),
            clip_distance_count: 0,
            color_mask_all_true: None,
            depth_mask: None,
            depth_func: None,
            stencil_mask_all: None,
            uniform_color_target: None,
            blend_all_disabled: true,
            index_buffer: None,
            copy_fbo_attachment: None,
            copy_fbo_dirty: false,
            active_texture: None,
        }
    }
}

fn extract_marker<'a>(data: &'a [u8], range: &core::ops::Range<u32>) -> &'a str {
    core::str::from_utf8(&data[range.start as usize..range.end as usize]).unwrap()
}

fn to_debug_str(s: &str) -> &str {
    // The spec mentions that if the length given to debug functions is negative,
    // the implementation will access the ptr and look for a null that terminates
    // the string but some implementations will try to access the ptr even if the
    // length is 0.
    if s.is_empty() {
        "<empty>"
    } else {
        s
    }
}

fn get_2d_target(target: u32, array_layer: u32) -> u32 {
    const CUBEMAP_FACES: [u32; 6] = [
        glow::TEXTURE_CUBE_MAP_POSITIVE_X,
        glow::TEXTURE_CUBE_MAP_NEGATIVE_X,
        glow::TEXTURE_CUBE_MAP_POSITIVE_Y,
        glow::TEXTURE_CUBE_MAP_NEGATIVE_Y,
        glow::TEXTURE_CUBE_MAP_POSITIVE_Z,
        glow::TEXTURE_CUBE_MAP_NEGATIVE_Z,
    ];

    match target {
        glow::TEXTURE_2D => target,
        glow::TEXTURE_CUBE_MAP => CUBEMAP_FACES[array_layer as usize],
        _ => unreachable!(),
    }
}

fn get_z_offset(target: u32, base: &crate::TextureCopyBase) -> u32 {
    match target {
        glow::TEXTURE_2D_ARRAY | glow::TEXTURE_CUBE_MAP_ARRAY => base.array_layer,
        glow::TEXTURE_3D => base.origin.z,
        _ => unreachable!(),
    }
}

impl super::Queue {
    /// Performs a manual shader clear, used as a workaround for a clearing bug on mesa
    unsafe fn perform_shader_clear(
        &self,
        gl: &glow::Context,
        st: &mut SubmitState,
        draw_buffer: u32,
        color: [f32; 4],
    ) {
        let shader_clear = self
            .shader_clear_program
            .as_ref()
            .expect("shader_clear_program should always be set if the workaround is enabled");
        unsafe { gl.use_program(Some(shader_clear.program)) };
        unsafe {
            gl.uniform_4_f32(
                Some(&shader_clear.color_uniform_location),
                color[0],
                color[1],
                color[2],
                color[3],
            )
        };
        unsafe { gl.disable(glow::DEPTH_TEST) };
        unsafe { gl.disable(glow::STENCIL_TEST) };
        unsafe { gl.disable(glow::SCISSOR_TEST) };
        unsafe { gl.disable(glow::BLEND) };
        unsafe { gl.disable(glow::CULL_FACE) };
        unsafe { gl.draw_buffers(&[glow::COLOR_ATTACHMENT0 + draw_buffer]) };
        unsafe { gl.draw_arrays(glow::TRIANGLES, 0, 3) };

        let draw_buffer_count = self.draw_buffer_count.load(Ordering::Relaxed);
        if draw_buffer_count != 0 {
            // Reset the draw buffers to what they were before the clear
            let indices = (0..draw_buffer_count as u32)
                .map(|i| glow::COLOR_ATTACHMENT0 + i)
                .collect::<ArrayVec<_, { crate::MAX_COLOR_ATTACHMENTS }>>();
            unsafe { gl.draw_buffers(&indices) };
        }

        // Drawpane: synchronize shadow state with the GL mutations performed above.
        st.program = Some(Some(shader_clear.program));
        st.depth_test = Some(false);
        st.stencil_test = Some(false);
        st.scissor_test = Some(false);
        st.uniform_color_target = None;
        st.blend_all_disabled = true;
        st.primitive = None;
        st.cull_face_enabled = Some(false);
    }

    unsafe fn reset_state(&self, gl: &glow::Context) {
        unsafe { gl.use_program(None) };
        unsafe { gl.bind_framebuffer(glow::FRAMEBUFFER, None) };
        unsafe { gl.disable(glow::DEPTH_TEST) };
        unsafe { gl.disable(glow::STENCIL_TEST) };
        unsafe { gl.disable(glow::SCISSOR_TEST) };
        unsafe { gl.disable(glow::BLEND) };
        unsafe { gl.disable(glow::CULL_FACE) };
        unsafe { gl.disable(glow::POLYGON_OFFSET_FILL) };
        unsafe { gl.disable(glow::SAMPLE_ALPHA_TO_COVERAGE) };
        if self.features.contains(wgt::Features::DEPTH_CLIP_CONTROL) {
            unsafe { gl.disable(glow::DEPTH_CLAMP) };
        }

        unsafe { gl.bind_buffer(glow::ELEMENT_ARRAY_BUFFER, None) };
        let mut current_index_buffer = self.current_index_buffer.lock();
        *current_index_buffer = None;
    }

    // Drawpane: between consecutive non-empty command buffers within one `submit`, restore only
    // the GL flags that `CommandEncoder::begin_encoding` assumes default-disabled and diffs
    // against in `set_render_pipeline` (so skipping `reset_state` cannot leak them).
    unsafe fn reset_cmd_buf_state(&self, gl: &glow::Context, st: &mut SubmitState) {
        if st.polygon_offset_enabled != Some(false) {
            unsafe { gl.disable(glow::POLYGON_OFFSET_FILL) };
            st.polygon_offset_enabled = Some(false);
        }
        if st.alpha_to_coverage != Some(false) {
            unsafe { gl.disable(glow::SAMPLE_ALPHA_TO_COVERAGE) };
            st.alpha_to_coverage = Some(false);
        }
        if st.clip_distance_count > 0 {
            for i in 0..st.clip_distance_count {
                unsafe { gl.disable(glow::CLIP_DISTANCE0 + i) };
            }
            st.clip_distance_count = 0;
        }
    }

    // Drawpane: unbind `ELEMENT_ARRAY_BUFFER` if bound before buffer-copy/clear commands so
    // WebGL2's buffer-target exclusivity never rejects binding a buffer that stayed bound from an
    // earlier render pass in the same submit.
    unsafe fn unbind_index_buffer_if_bound(&self, gl: &glow::Context, st: &mut SubmitState) {
        if st.index_buffer.is_some() {
            unsafe { gl.bind_buffer(glow::ELEMENT_ARRAY_BUFFER, None) };
            st.index_buffer = None;
            *self.current_index_buffer.lock() = None;
        }
    }

    // Drawpane: leave clean GL state at the end of `submit` so `Surface::present` (whose non-sRGB
    // path calls `gl.blit_framebuffer` directly) never sees a stale scissor/color-mask and
    // `copy_fbo` never pins texture storage across frames.
    unsafe fn finish_submit_state(&self, gl: &glow::Context, st: &mut SubmitState) {
        if st.scissor_test != Some(false) {
            unsafe { gl.disable(glow::SCISSOR_TEST) };
            st.scissor_test = Some(false);
        }
        if st.color_mask_all_true != Some(true) {
            unsafe { gl.color_mask(true, true, true, true) };
            st.color_mask_all_true = Some(true);
            if let Some(ref mut target) = st.uniform_color_target {
                target.mask = wgt::ColorWrites::ALL;
            }
        }
        unsafe { self.unbind_index_buffer_if_bound(gl, st) };
        if st.copy_fbo_dirty {
            if st.read_fbo != ReadFboBinding::CopyFbo {
                unsafe { gl.bind_framebuffer(glow::READ_FRAMEBUFFER, Some(self.copy_fbo)) };
            }
            unsafe {
                gl.framebuffer_texture_2d(
                    glow::READ_FRAMEBUFFER,
                    glow::COLOR_ATTACHMENT0,
                    glow::TEXTURE_2D,
                    None,
                    0,
                );
            }
            unsafe { gl.bind_framebuffer(glow::READ_FRAMEBUFFER, None) };
            st.read_fbo = ReadFboBinding::Default;
            st.copy_fbo_attachment = None;
            st.copy_fbo_dirty = false;
        }
    }

    // Drawpane: cross-check every shadowed piece of GL state against the live GL context in debug
    // builds before draws and clears so any shadow-state drift fails loudly.
    #[cfg(debug_assertions)]
    unsafe fn debug_verify_gl_state(&self, gl: &glow::Context, st: &SubmitState) {
        #[cfg(webgl)]
        if self.shared.context.webgl2_context.is_context_lost() {
            return;
        }
        if let Some(expected) = st.depth_test {
            debug_assert_eq!(
                unsafe { gl.is_enabled(glow::DEPTH_TEST) },
                expected,
                "GL shadow mismatch: DEPTH_TEST"
            );
        }
        if let Some(expected) = st.stencil_test {
            debug_assert_eq!(
                unsafe { gl.is_enabled(glow::STENCIL_TEST) },
                expected,
                "GL shadow mismatch: STENCIL_TEST"
            );
        }
        if let Some(expected) = st.scissor_test {
            debug_assert_eq!(
                unsafe { gl.is_enabled(glow::SCISSOR_TEST) },
                expected,
                "GL shadow mismatch: SCISSOR_TEST"
            );
        }
        if let Some(expected) = st.polygon_offset_enabled {
            debug_assert_eq!(
                unsafe { gl.is_enabled(glow::POLYGON_OFFSET_FILL) },
                expected,
                "GL shadow mismatch: POLYGON_OFFSET_FILL"
            );
        }
        if let Some(expected) = st.alpha_to_coverage {
            debug_assert_eq!(
                unsafe { gl.is_enabled(glow::SAMPLE_ALPHA_TO_COVERAGE) },
                expected,
                "GL shadow mismatch: SAMPLE_ALPHA_TO_COVERAGE"
            );
        }
        if let Some(expected) = st.cull_face_enabled {
            debug_assert_eq!(
                unsafe { gl.is_enabled(glow::CULL_FACE) },
                expected,
                "GL shadow mismatch: CULL_FACE"
            );
        }
        if let Some(expected) = st.depth_mask {
            debug_assert_eq!(
                unsafe { gl.get_parameter_bool(glow::DEPTH_WRITEMASK) },
                expected,
                "GL shadow mismatch: DEPTH_WRITEMASK"
            );
        }
        if st.color_mask_all_true == Some(true) {
            debug_assert_eq!(
                unsafe { gl.get_parameter_bool_array::<4>(glow::COLOR_WRITEMASK) },
                [true, true, true, true],
                "GL shadow mismatch: COLOR_WRITEMASK"
            );
        }
        if st.blend_all_disabled {
            debug_assert!(
                !unsafe { gl.is_enabled(glow::BLEND) },
                "GL shadow mismatch: BLEND expected disabled"
            );
        } else if let Some(ref target) = st.uniform_color_target {
            debug_assert_eq!(
                unsafe { gl.is_enabled(glow::BLEND) },
                target.blend.is_some(),
                "GL shadow mismatch: BLEND"
            );
        }
        if let Some(expected) = st.scissor_rect {
            let mut actual = [0i32; 4];
            unsafe { gl.get_parameter_i32_slice(glow::SCISSOR_BOX, &mut actual) };
            debug_assert_eq!(actual, expected, "GL shadow mismatch: SCISSOR_BOX");
        }
        if let Some(expected) = st.viewport {
            let mut actual = [0i32; 4];
            unsafe { gl.get_parameter_i32_slice(glow::VIEWPORT, &mut actual) };
            debug_assert_eq!(actual, expected, "GL shadow mismatch: VIEWPORT");
        }
        if let Some(ref prim) = st.primitive {
            debug_assert_eq!(
                unsafe { gl.get_parameter_i32(glow::FRONT_FACE) as u32 },
                prim.front_face,
                "GL shadow mismatch: FRONT_FACE"
            );
        }
        // Drawpane: glow on the web panics when getParameter returns null (no program bound, or
        // the default framebuffer), so only a bound program and a cached framebuffer are checked.
        if let Some(Some(expected)) = st.program {
            debug_assert_eq!(
                unsafe { gl.get_parameter_program(glow::CURRENT_PROGRAM) },
                Some(expected),
                "GL shadow mismatch: CURRENT_PROGRAM"
            );
        }
        match st.draw_fbo {
            DrawFboBinding::Default => {}
            DrawFboBinding::Cached(fbo) => {
                debug_assert_eq!(
                    unsafe { gl.get_parameter_framebuffer(glow::DRAW_FRAMEBUFFER_BINDING) },
                    Some(fbo),
                    "GL shadow mismatch: DRAW_FRAMEBUFFER (cached)"
                );
                debug_assert_eq!(
                    unsafe { gl.check_framebuffer_status(glow::DRAW_FRAMEBUFFER) },
                    glow::FRAMEBUFFER_COMPLETE,
                    "Cached draw FBO is not FRAMEBUFFER_COMPLETE"
                );
            }
            DrawFboBinding::Fallback => {
                debug_assert_eq!(
                    unsafe { gl.get_parameter_framebuffer(glow::DRAW_FRAMEBUFFER_BINDING) },
                    Some(self.draw_fbo),
                    "GL shadow mismatch: DRAW_FRAMEBUFFER (fallback)"
                );
            }
            DrawFboBinding::External => {}
        }
    }

    // Drawpane: coalesce `ResetFramebuffer` plus its immediately following `BindAttachment`
    // commands so normal render passes bind a cached complete FBO with zero attachment detaches
    // and only update dirty clear-precondition flags.
    unsafe fn process_framebuffer_setup(
        &self,
        gl: &glow::Context,
        st: &mut SubmitState,
        is_default: bool,
        bind_cmds: &[C],
        next_is_scissor: bool,
    ) {
        if is_default {
            if st.draw_fbo != DrawFboBinding::Default {
                unsafe { gl.bind_framebuffer(glow::DRAW_FRAMEBUFFER, None) };
                st.draw_fbo = DrawFboBinding::Default;
            }
            st.active_draw_fbo_draw_buffers = None;
        } else {
            let mut key = FboKey::default();
            let mut cacheable = true;
            let mut is_external = false;

            for cmd in bind_cmds {
                if let C::BindAttachment {
                    attachment,
                    ref view,
                    depth_slice,
                    sample_count,
                } = *cmd
                {
                    match view.inner {
                        #[cfg(webgl)]
                        super::TextureInner::ExternalFramebuffer { .. } => {
                            is_external = true;
                            cacheable = false;
                            break;
                        }
                        #[cfg(native)]
                        super::TextureInner::ExternalNativeFramebuffer { .. } => {
                            is_external = true;
                            cacheable = false;
                            break;
                        }
                        _ => {}
                    }
                    let Some(att_key) = FboAttachmentKey::from_view(view, depth_slice, sample_count)
                    else {
                        cacheable = false;
                        break;
                    };
                    if attachment >= glow::COLOR_ATTACHMENT0
                        && attachment < glow::COLOR_ATTACHMENT0 + crate::MAX_COLOR_ATTACHMENTS as u32
                    {
                        key.color[(attachment - glow::COLOR_ATTACHMENT0) as usize] = Some(att_key);
                    } else if matches!(
                        attachment,
                        glow::DEPTH_ATTACHMENT
                            | glow::STENCIL_ATTACHMENT
                            | glow::DEPTH_STENCIL_ATTACHMENT
                    ) {
                        key.depth_stencil = Some((attachment, att_key));
                    } else {
                        cacheable = false;
                        break;
                    }
                }
            }

            let bound_from_cache = if cacheable {
                let acquired = unsafe { self.shared.fbo_cache.lock().acquire(gl, key, st.draw_fbo) };
                if let Some((fbo, draw_buffers)) = acquired {
                    st.draw_fbo = DrawFboBinding::Cached(fbo);
                    st.active_draw_fbo_draw_buffers = draw_buffers;
                    true
                } else {
                    false
                }
            } else {
                false
            };

            if !bound_from_cache {
                if is_external {
                    for cmd in bind_cmds {
                        if let C::BindAttachment {
                            attachment,
                            ref view,
                            depth_slice,
                            sample_count,
                        } = *cmd
                        {
                            unsafe {
                                self.set_attachment(
                                    gl,
                                    glow::DRAW_FRAMEBUFFER,
                                    attachment,
                                    view,
                                    depth_slice,
                                    sample_count,
                                )
                            };
                        }
                    }
                    st.draw_fbo = DrawFboBinding::External;
                    st.read_fbo = ReadFboBinding::Unknown;
                    st.active_draw_fbo_draw_buffers = None;
                } else {
                    // Fallback uncached path matching upstream semantics.
                    unsafe { gl.bind_framebuffer(glow::DRAW_FRAMEBUFFER, Some(self.draw_fbo)) };
                    unsafe {
                        gl.framebuffer_texture_2d(
                            glow::DRAW_FRAMEBUFFER,
                            glow::DEPTH_STENCIL_ATTACHMENT,
                            glow::TEXTURE_2D,
                            None,
                            0,
                        )
                    };
                    for i in 0..self.shared.limits.max_color_attachments {
                        let target = glow::COLOR_ATTACHMENT0 + i;
                        unsafe {
                            gl.framebuffer_texture_2d(
                                glow::DRAW_FRAMEBUFFER,
                                target,
                                glow::TEXTURE_2D,
                                None,
                                0,
                            )
                        };
                    }
                    for cmd in bind_cmds {
                        if let C::BindAttachment {
                            attachment,
                            ref view,
                            depth_slice,
                            sample_count,
                        } = *cmd
                        {
                            unsafe {
                                self.set_attachment(
                                    gl,
                                    glow::DRAW_FRAMEBUFFER,
                                    attachment,
                                    view,
                                    depth_slice,
                                    sample_count,
                                )
                            };
                        }
                    }
                    st.draw_fbo = DrawFboBinding::Fallback;
                    st.active_draw_fbo_draw_buffers = None;
                }
            }
        }

        if st.color_mask_all_true != Some(true) {
            unsafe { gl.color_mask(true, true, true, true) };
            st.color_mask_all_true = Some(true);
            if let Some(ref mut target) = st.uniform_color_target {
                target.mask = wgt::ColorWrites::ALL;
            }
        }
        if st.depth_mask != Some(true) {
            unsafe { gl.depth_mask(true) };
            st.depth_mask = Some(true);
        }
        if st.stencil_mask_all != Some(true) {
            unsafe { gl.stencil_mask(!0) };
            st.stencil_mask_all = Some(true);
        }
        if st.depth_test != Some(false) {
            unsafe { gl.disable(glow::DEPTH_TEST) };
            st.depth_test = Some(false);
        }
        if st.stencil_test != Some(false) {
            unsafe { gl.disable(glow::STENCIL_TEST) };
            st.stencil_test = Some(false);
        }
        if !next_is_scissor && st.scissor_test != Some(false) {
            unsafe { gl.disable(glow::SCISSOR_TEST) };
            st.scissor_test = Some(false);
        }
    }

    unsafe fn set_attachment(
        &self,
        gl: &glow::Context,
        fbo_target: u32,
        attachment: u32,
        view: &super::TextureView,
        depth_slice: Option<u32>,
        sample_count: u32,
    ) {
        match view.inner {
            super::TextureInner::Renderbuffer { raw } => {
                unsafe {
                    gl.framebuffer_renderbuffer(
                        fbo_target,
                        attachment,
                        glow::RENDERBUFFER,
                        Some(raw),
                    )
                };
            }
            super::TextureInner::DefaultRenderbuffer => panic!("Unexpected default RBO"),
            super::TextureInner::Texture { raw, target } => {
                let num_layers = view.array_layers.end - view.array_layers.start;
                if num_layers > 1 {
                    #[cfg(webgl)]
                    unsafe {
                        gl.framebuffer_texture_multiview_ovr(
                            fbo_target,
                            attachment,
                            Some(raw),
                            view.mip_levels.start as i32,
                            view.array_layers.start as i32,
                            num_layers as i32,
                        )
                    };
                } else if is_layered_target(target) {
                    let layer = if target == glow::TEXTURE_3D {
                        depth_slice.unwrap() as i32
                    } else {
                        view.array_layers.start as i32
                    };
                    unsafe {
                        gl.framebuffer_texture_layer(
                            fbo_target,
                            attachment,
                            Some(raw),
                            view.mip_levels.start as i32,
                            layer,
                        )
                    };
                } else {
                    unsafe {
                        assert_eq!(view.mip_levels.len(), 1);
                        if sample_count != 1 {
                            gl.framebuffer_texture_2d_multisample(
                                fbo_target,
                                attachment,
                                get_2d_target(target, view.array_layers.start),
                                Some(raw),
                                view.mip_levels.start as i32,
                                sample_count as i32,
                            )
                        } else {
                            gl.framebuffer_texture_2d(
                                fbo_target,
                                attachment,
                                get_2d_target(target, view.array_layers.start),
                                Some(raw),
                                view.mip_levels.start as i32,
                            )
                        }
                    };
                }
            }
            #[cfg(webgl)]
            super::TextureInner::ExternalFramebuffer { ref inner } => unsafe {
                gl.bind_external_framebuffer(glow::FRAMEBUFFER, inner);
            },
            #[cfg(native)]
            super::TextureInner::ExternalNativeFramebuffer { ref inner } => unsafe {
                gl.bind_framebuffer(glow::FRAMEBUFFER, Some(*inner));
            },
        }
    }

    unsafe fn process(
        &self,
        gl: &glow::Context,
        st: &mut SubmitState,
        command: &C,
        #[cfg_attr(target_arch = "wasm32", allow(unused))] data_bytes: &[u8],
        queries: &[glow::Query],
    ) {
        match *command {
            C::Draw {
                topology,
                first_vertex,
                vertex_count,
                instance_count,
                first_instance,
                ref first_instance_location,
            } => {
                #[cfg(debug_assertions)]
                unsafe {
                    self.debug_verify_gl_state(gl, st);
                }
                let supports_full_instancing = self
                    .shared
                    .private_caps
                    .contains(PrivateCapabilities::FULLY_FEATURED_INSTANCING);

                if supports_full_instancing {
                    unsafe {
                        gl.draw_arrays_instanced_base_instance(
                            topology,
                            first_vertex as i32,
                            vertex_count as i32,
                            instance_count as i32,
                            first_instance,
                        )
                    }
                } else {
                    unsafe {
                        gl.uniform_1_u32(first_instance_location.as_ref(), first_instance);
                    }

                    // Don't use `gl.draw_arrays` for `instance_count == 1`.
                    // Angle has a bug where it doesn't consider the instance divisor when `DYNAMIC_DRAW` is used in `draw_arrays`.
                    // See https://github.com/gfx-rs/wgpu/issues/3578
                    unsafe {
                        gl.draw_arrays_instanced(
                            topology,
                            first_vertex as i32,
                            vertex_count as i32,
                            instance_count as i32,
                        )
                    }
                };
            }
            C::DrawIndexed {
                topology,
                index_type,
                index_count,
                index_offset,
                base_vertex,
                first_instance,
                instance_count,
                ref first_instance_location,
            } => {
                #[cfg(debug_assertions)]
                unsafe {
                    self.debug_verify_gl_state(gl, st);
                }
                let supports_full_instancing = self
                    .shared
                    .private_caps
                    .contains(PrivateCapabilities::FULLY_FEATURED_INSTANCING);

                if supports_full_instancing {
                    unsafe {
                        gl.draw_elements_instanced_base_vertex_base_instance(
                            topology,
                            index_count as i32,
                            index_type,
                            index_offset as i32,
                            instance_count as i32,
                            base_vertex,
                            first_instance,
                        )
                    }
                } else {
                    unsafe { gl.uniform_1_u32(first_instance_location.as_ref(), first_instance) };

                    if base_vertex == 0 {
                        unsafe {
                            // Don't use `gl.draw_elements`/`gl.draw_elements_base_vertex` for `instance_count == 1`.
                            // Angle has a bug where it doesn't consider the instance divisor when `DYNAMIC_DRAW` is used in `gl.draw_elements`/`gl.draw_elements_base_vertex`.
                            // See https://github.com/gfx-rs/wgpu/issues/3578
                            gl.draw_elements_instanced(
                                topology,
                                index_count as i32,
                                index_type,
                                index_offset as i32,
                                instance_count as i32,
                            )
                        }
                    } else {
                        // If we've gotten here, wgpu-core has already validated that this function exists via the DownlevelFlags::BASE_VERTEX feature.
                        unsafe {
                            gl.draw_elements_instanced_base_vertex(
                                topology,
                                index_count as _,
                                index_type,
                                index_offset as i32,
                                instance_count as i32,
                                base_vertex,
                            )
                        }
                    }
                }
            }
            C::DrawIndirect {
                topology,
                indirect_buf,
                indirect_offset,
                ref first_instance_location,
            } => {
                #[cfg(debug_assertions)]
                unsafe {
                    self.debug_verify_gl_state(gl, st);
                }
                unsafe { gl.uniform_1_u32(first_instance_location.as_ref(), 0) };

                unsafe { gl.bind_buffer(glow::DRAW_INDIRECT_BUFFER, Some(indirect_buf)) };
                unsafe { gl.draw_arrays_indirect_offset(topology, indirect_offset as i32) };
            }
            C::DrawIndexedIndirect {
                topology,
                index_type,
                indirect_buf,
                indirect_offset,
                ref first_instance_location,
            } => {
                #[cfg(debug_assertions)]
                unsafe {
                    self.debug_verify_gl_state(gl, st);
                }
                unsafe { gl.uniform_1_u32(first_instance_location.as_ref(), 0) };

                unsafe { gl.bind_buffer(glow::DRAW_INDIRECT_BUFFER, Some(indirect_buf)) };
                unsafe {
                    gl.draw_elements_indirect_offset(topology, index_type, indirect_offset as i32)
                };
            }
            C::Dispatch(group_counts) => {
                unsafe { gl.dispatch_compute(group_counts[0], group_counts[1], group_counts[2]) };
            }
            C::DispatchIndirect {
                indirect_buf,
                indirect_offset,
            } => {
                unsafe { gl.bind_buffer(glow::DISPATCH_INDIRECT_BUFFER, Some(indirect_buf)) };
                unsafe { gl.dispatch_compute_indirect(indirect_offset as i32) };
            }
            C::ClearBuffer {
                ref dst,
                dst_target,
                ref range,
            } => match dst.raw {
                Some(buffer) => {
                    unsafe { self.unbind_index_buffer_if_bound(gl, st) };
                    // When `INDEX_BUFFER_ROLE_CHANGE` isn't available, we can't copy into the
                    // index buffer from the zero buffer. This would fail in Chrome with the
                    // following message:
                    //
                    // > Cannot copy into an element buffer destination from a non-element buffer
                    // > source
                    //
                    // Instead, we'll upload zeroes into the buffer.
                    let can_use_zero_buffer = self
                        .shared
                        .private_caps
                        .contains(PrivateCapabilities::INDEX_BUFFER_ROLE_CHANGE)
                        || dst_target != glow::ELEMENT_ARRAY_BUFFER;

                    if can_use_zero_buffer {
                        unsafe { gl.bind_buffer(glow::COPY_READ_BUFFER, Some(self.zero_buffer)) };
                        unsafe { gl.bind_buffer(dst_target, Some(buffer)) };
                        let mut dst_offset = range.start;
                        while dst_offset < range.end {
                            let size = (range.end - dst_offset).min(super::ZERO_BUFFER_SIZE as u64);
                            unsafe {
                                gl.copy_buffer_sub_data(
                                    glow::COPY_READ_BUFFER,
                                    dst_target,
                                    0,
                                    dst_offset as i32,
                                    size as i32,
                                )
                            };
                            dst_offset += size;
                        }
                    } else {
                        unsafe { gl.bind_buffer(dst_target, Some(buffer)) };
                        let zeroes = vec![0u8; (range.end - range.start) as usize];
                        unsafe {
                            gl.buffer_sub_data_u8_slice(dst_target, range.start as i32, &zeroes)
                        };
                    }
                    if dst_target == glow::ELEMENT_ARRAY_BUFFER {
                        unsafe { gl.bind_buffer(glow::ELEMENT_ARRAY_BUFFER, None) };
                    }
                }
                None => {
                    let mut map_state = lock(&dst.map_state);
                    map_state.data.as_mut().unwrap().as_mut_slice()
                        [range.start as usize..range.end as usize]
                        .fill(0);
                }
            },
            C::CopyBufferToBuffer {
                ref src,
                src_target,
                ref dst,
                dst_target,
                copy,
            } => {
                unsafe { self.unbind_index_buffer_if_bound(gl, st) };
                let copy_src_target = glow::COPY_READ_BUFFER;
                let is_index_buffer_only_element_dst = !self
                    .shared
                    .private_caps
                    .contains(PrivateCapabilities::INDEX_BUFFER_ROLE_CHANGE)
                    && dst_target == glow::ELEMENT_ARRAY_BUFFER
                    || src_target == glow::ELEMENT_ARRAY_BUFFER;

                // WebGL not allowed to copy data from other targets to element buffer and can't copy element data to other buffers
                let copy_dst_target = if is_index_buffer_only_element_dst {
                    glow::ELEMENT_ARRAY_BUFFER
                } else {
                    glow::COPY_WRITE_BUFFER
                };
                let size = copy.size.get() as usize;
                match (src.raw, dst.raw) {
                    (Some(ref src), Some(ref dst)) => {
                        unsafe { gl.bind_buffer(copy_src_target, Some(*src)) };
                        unsafe { gl.bind_buffer(copy_dst_target, Some(*dst)) };
                        unsafe {
                            gl.copy_buffer_sub_data(
                                copy_src_target,
                                copy_dst_target,
                                copy.src_offset as _,
                                copy.dst_offset as _,
                                copy.size.get() as _,
                            )
                        };
                    }
                    (Some(src), None) => {
                        let mut map_state = lock(&dst.map_state);
                        let dst_data = &mut map_state.data.as_mut().unwrap().as_mut_slice()
                            [copy.dst_offset as usize..copy.dst_offset as usize + size];

                        unsafe { gl.bind_buffer(copy_src_target, Some(src)) };
                        unsafe {
                            self.shared.get_buffer_sub_data(
                                gl,
                                copy_src_target,
                                copy.src_offset as i32,
                                dst_data,
                            )
                        };
                    }
                    (None, Some(dst)) => {
                        let map_state = lock(&src.map_state);
                        let src_data = &map_state.data.as_ref().unwrap().as_slice()
                            [copy.src_offset as usize..copy.src_offset as usize + size];
                        unsafe { gl.bind_buffer(copy_dst_target, Some(dst)) };
                        unsafe {
                            gl.buffer_sub_data_u8_slice(
                                copy_dst_target,
                                copy.dst_offset as i32,
                                src_data,
                            )
                        };
                    }
                    (None, None) => {
                        todo!()
                    }
                }
                unsafe { gl.bind_buffer(copy_src_target, None) };
                if is_index_buffer_only_element_dst {
                    unsafe {
                        gl.bind_buffer(
                            glow::ELEMENT_ARRAY_BUFFER,
                            *self.current_index_buffer.lock(),
                        )
                    };
                } else {
                    unsafe { gl.bind_buffer(copy_dst_target, None) };
                }
            }
            #[cfg(webgl)]
            C::CopyExternalImageToTexture {
                ref src,
                dst,
                dst_target,
                dst_format,
                dst_premultiplication,
                ref copy,
            } => {
                const UNPACK_FLIP_Y_WEBGL: u32 =
                    web_sys::WebGl2RenderingContext::UNPACK_FLIP_Y_WEBGL;
                const UNPACK_PREMULTIPLY_ALPHA_WEBGL: u32 =
                    web_sys::WebGl2RenderingContext::UNPACK_PREMULTIPLY_ALPHA_WEBGL;

                unsafe {
                    if src.flip_y {
                        gl.pixel_store_bool(UNPACK_FLIP_Y_WEBGL, true);
                    }
                    if dst_premultiplication {
                        gl.pixel_store_bool(UNPACK_PREMULTIPLY_ALPHA_WEBGL, true);
                    }
                }
                // Drawpane: a source origin is a sub-rectangle of the image (WebGL2 applies the
                // unpack skips to a TexImageSource), so an image can be uploaded in strips.
                let skip = copy.src_base.origin;
                unsafe {
                    if skip.x != 0 {
                        gl.pixel_store_i32(glow::UNPACK_SKIP_PIXELS, skip.x as i32);
                    }
                    if skip.y != 0 {
                        gl.pixel_store_i32(glow::UNPACK_SKIP_ROWS, skip.y as i32);
                    }
                }

                unsafe { gl.bind_texture(dst_target, Some(dst)) };
                let format_desc = self.shared.describe_texture_format(dst_format);
                if is_layered_target(dst_target) {
                    let z_offset = get_z_offset(dst_target, &copy.dst_base);

                    match src.source {
                        wgt::ExternalImageSource::ImageBitmap(ref b) => unsafe {
                            gl.tex_sub_image_3d_with_image_bitmap(
                                dst_target,
                                copy.dst_base.mip_level as i32,
                                copy.dst_base.origin.x as i32,
                                copy.dst_base.origin.y as i32,
                                z_offset as i32,
                                copy.size.width as i32,
                                copy.size.height as i32,
                                copy.size.depth as i32,
                                format_desc.external,
                                format_desc.data_type,
                                b,
                            );
                        },
                        wgt::ExternalImageSource::HTMLImageElement(ref i) => unsafe {
                            gl.tex_sub_image_3d_with_html_image_element(
                                dst_target,
                                copy.dst_base.mip_level as i32,
                                copy.dst_base.origin.x as i32,
                                copy.dst_base.origin.y as i32,
                                z_offset as i32,
                                copy.size.width as i32,
                                copy.size.height as i32,
                                copy.size.depth as i32,
                                format_desc.external,
                                format_desc.data_type,
                                i,
                            );
                        },
                        wgt::ExternalImageSource::HTMLVideoElement(ref v) => unsafe {
                            gl.tex_sub_image_3d_with_html_video_element(
                                dst_target,
                                copy.dst_base.mip_level as i32,
                                copy.dst_base.origin.x as i32,
                                copy.dst_base.origin.y as i32,
                                z_offset as i32,
                                copy.size.width as i32,
                                copy.size.height as i32,
                                copy.size.depth as i32,
                                format_desc.external,
                                format_desc.data_type,
                                v,
                            );
                        },
                        #[cfg(not(web_sys_unstable_apis))]
                        wgt::ExternalImageSource::VideoFrame(_) => {
                            unimplemented!("web_sys_unstable_apis is needed for glow")
                        }
                        #[cfg(web_sys_unstable_apis)]
                        wgt::ExternalImageSource::VideoFrame(ref v) => unsafe {
                            gl.tex_sub_image_3d_with_video_frame(
                                dst_target,
                                copy.dst_base.mip_level as i32,
                                copy.dst_base.origin.x as i32,
                                copy.dst_base.origin.y as i32,
                                z_offset as i32,
                                copy.size.width as i32,
                                copy.size.height as i32,
                                copy.size.depth as i32,
                                format_desc.external,
                                format_desc.data_type,
                                v,
                            )
                        },
                        wgt::ExternalImageSource::ImageData(ref i) => unsafe {
                            gl.tex_sub_image_3d_with_image_data(
                                dst_target,
                                copy.dst_base.mip_level as i32,
                                copy.dst_base.origin.x as i32,
                                copy.dst_base.origin.y as i32,
                                z_offset as i32,
                                copy.size.width as i32,
                                copy.size.height as i32,
                                copy.size.depth as i32,
                                format_desc.external,
                                format_desc.data_type,
                                i,
                            );
                        },
                        wgt::ExternalImageSource::HTMLCanvasElement(ref c) => unsafe {
                            gl.tex_sub_image_3d_with_html_canvas_element(
                                dst_target,
                                copy.dst_base.mip_level as i32,
                                copy.dst_base.origin.x as i32,
                                copy.dst_base.origin.y as i32,
                                z_offset as i32,
                                copy.size.width as i32,
                                copy.size.height as i32,
                                copy.size.depth as i32,
                                format_desc.external,
                                format_desc.data_type,
                                c,
                            );
                        },
                        wgt::ExternalImageSource::OffscreenCanvas(_) => unreachable!(),
                    }
                } else {
                    let dst_target = get_2d_target(dst_target, copy.dst_base.array_layer);

                    match src.source {
                        wgt::ExternalImageSource::ImageBitmap(ref b) => unsafe {
                            gl.tex_sub_image_2d_with_image_bitmap_and_width_and_height(
                                dst_target,
                                copy.dst_base.mip_level as i32,
                                copy.dst_base.origin.x as i32,
                                copy.dst_base.origin.y as i32,
                                copy.size.width as i32,
                                copy.size.height as i32,
                                format_desc.external,
                                format_desc.data_type,
                                b,
                            );
                        },
                        wgt::ExternalImageSource::HTMLImageElement(ref i) => unsafe {
                            gl.tex_sub_image_2d_with_html_image_and_width_and_height(
                                dst_target,
                                copy.dst_base.mip_level as i32,
                                copy.dst_base.origin.x as i32,
                                copy.dst_base.origin.y as i32,
                                copy.size.width as i32,
                                copy.size.height as i32,
                                format_desc.external,
                                format_desc.data_type,
                                i,
                            )
                        },
                        wgt::ExternalImageSource::HTMLVideoElement(ref v) => unsafe {
                            gl.tex_sub_image_2d_with_html_video_and_width_and_height(
                                dst_target,
                                copy.dst_base.mip_level as i32,
                                copy.dst_base.origin.x as i32,
                                copy.dst_base.origin.y as i32,
                                copy.size.width as i32,
                                copy.size.height as i32,
                                format_desc.external,
                                format_desc.data_type,
                                v,
                            )
                        },
                        #[cfg(not(web_sys_unstable_apis))]
                        wgt::ExternalImageSource::VideoFrame(_) => {
                            unimplemented!("web_sys_unstable_apis is needed for glow")
                        }
                        #[cfg(web_sys_unstable_apis)]
                        wgt::ExternalImageSource::VideoFrame(ref v) => unsafe {
                            gl.tex_sub_image_2d_with_video_frame_and_width_and_height(
                                dst_target,
                                copy.dst_base.mip_level as i32,
                                copy.dst_base.origin.x as i32,
                                copy.dst_base.origin.y as i32,
                                copy.size.width as i32,
                                copy.size.height as i32,
                                format_desc.external,
                                format_desc.data_type,
                                v,
                            )
                        },
                        wgt::ExternalImageSource::ImageData(ref i) => unsafe {
                            gl.tex_sub_image_2d_with_image_data_and_width_and_height(
                                dst_target,
                                copy.dst_base.mip_level as i32,
                                copy.dst_base.origin.x as i32,
                                copy.dst_base.origin.y as i32,
                                copy.size.width as i32,
                                copy.size.height as i32,
                                format_desc.external,
                                format_desc.data_type,
                                i,
                            );
                        },
                        wgt::ExternalImageSource::HTMLCanvasElement(ref c) => unsafe {
                            gl.tex_sub_image_2d_with_html_canvas_and_width_and_height(
                                dst_target,
                                copy.dst_base.mip_level as i32,
                                copy.dst_base.origin.x as i32,
                                copy.dst_base.origin.y as i32,
                                copy.size.width as i32,
                                copy.size.height as i32,
                                format_desc.external,
                                format_desc.data_type,
                                c,
                            )
                        },
                        wgt::ExternalImageSource::OffscreenCanvas(_) => unreachable!(),
                    }
                }

                unsafe {
                    if src.flip_y {
                        gl.pixel_store_bool(UNPACK_FLIP_Y_WEBGL, false);
                    }
                    if dst_premultiplication {
                        gl.pixel_store_bool(UNPACK_PREMULTIPLY_ALPHA_WEBGL, false);
                    }
                    // Drawpane: back to the defaults the other uploads assume.
                    if skip.x != 0 {
                        gl.pixel_store_i32(glow::UNPACK_SKIP_PIXELS, 0);
                    }
                    if skip.y != 0 {
                        gl.pixel_store_i32(glow::UNPACK_SKIP_ROWS, 0);
                    }
                }
            }
            C::CopyTextureToTexture {
                src,
                src_target,
                dst,
                dst_target,
                ref copy,
            } => {
                //TODO: handle 3D copies
                // Drawpane: reuse `copy_fbo` binding and attachment across consecutive copies
                // from the same source texture/mip/layer within a submit.
                let read_att = if is_layered_target(src_target) {
                    FboAttachmentKey::TextureLayer {
                        raw: src,
                        mip_level: copy.src_base.mip_level as i32,
                        layer: copy.src_base.array_layer as i32,
                    }
                } else {
                    FboAttachmentKey::Texture2D {
                        raw: src,
                        target: src_target,
                        mip_level: copy.src_base.mip_level as i32,
                        sample_count: 1,
                    }
                };
                if st.read_fbo != ReadFboBinding::CopyFbo {
                    unsafe { gl.bind_framebuffer(glow::READ_FRAMEBUFFER, Some(self.copy_fbo)) };
                    st.read_fbo = ReadFboBinding::CopyFbo;
                }
                if st.copy_fbo_attachment != Some(read_att) {
                    unsafe {
                        read_att.attach(gl, glow::READ_FRAMEBUFFER, glow::COLOR_ATTACHMENT0);
                    }
                    st.copy_fbo_attachment = Some(read_att);
                    st.copy_fbo_dirty = true;
                }

                unsafe { gl.bind_texture(dst_target, Some(dst)) };
                if is_layered_target(dst_target) {
                    unsafe {
                        gl.copy_tex_sub_image_3d(
                            dst_target,
                            copy.dst_base.mip_level as i32,
                            copy.dst_base.origin.x as i32,
                            copy.dst_base.origin.y as i32,
                            get_z_offset(dst_target, &copy.dst_base) as i32,
                            copy.src_base.origin.x as i32,
                            copy.src_base.origin.y as i32,
                            copy.size.width as i32,
                            copy.size.height as i32,
                        )
                    };
                } else {
                    unsafe {
                        gl.copy_tex_sub_image_2d(
                            get_2d_target(dst_target, copy.dst_base.array_layer),
                            copy.dst_base.mip_level as i32,
                            copy.dst_base.origin.x as i32,
                            copy.dst_base.origin.y as i32,
                            copy.src_base.origin.x as i32,
                            copy.src_base.origin.y as i32,
                            copy.size.width as i32,
                            copy.size.height as i32,
                        )
                    };
                }
            }
            C::CopyBufferToTexture {
                ref src,
                src_target: _,
                dst,
                dst_target,
                dst_format,
                ref copy,
            } => {
                if src.raw.is_some() {
                    unsafe { self.unbind_index_buffer_if_bound(gl, st) };
                }
                let (block_width, block_height) = dst_format.block_dimensions();
                let block_size = dst_format.block_copy_size(None).unwrap();
                let format_desc = self.shared.describe_texture_format(dst_format);
                let row_texels = copy
                    .buffer_layout
                    .bytes_per_row
                    .map_or(0, |bpr| block_width * bpr / block_size);
                let column_texels = copy
                    .buffer_layout
                    .rows_per_image
                    .map_or(0, |rpi| block_height * rpi);

                unsafe { gl.bind_texture(dst_target, Some(dst)) };
                unsafe { gl.pixel_store_i32(glow::UNPACK_ROW_LENGTH, row_texels as i32) };
                unsafe { gl.pixel_store_i32(glow::UNPACK_IMAGE_HEIGHT, column_texels as i32) };
                let mut unbind_unpack_buffer = false;
                if !dst_format.is_compressed() {
                    let map_state;
                    let unpack_data = match src.raw {
                        Some(buffer) => {
                            unsafe { gl.bind_buffer(glow::PIXEL_UNPACK_BUFFER, Some(buffer)) };
                            unbind_unpack_buffer = true;
                            glow::PixelUnpackData::BufferOffset(copy.buffer_layout.offset as u32)
                        }
                        None => {
                            map_state = lock(&src.map_state);
                            let src_data = &map_state.data.as_ref().unwrap().as_slice()
                                [copy.buffer_layout.offset as usize..];
                            glow::PixelUnpackData::Slice(Some(src_data))
                        }
                    };
                    if is_layered_target(dst_target) {
                        unsafe {
                            gl.tex_sub_image_3d(
                                dst_target,
                                copy.texture_base.mip_level as i32,
                                copy.texture_base.origin.x as i32,
                                copy.texture_base.origin.y as i32,
                                get_z_offset(dst_target, &copy.texture_base) as i32,
                                copy.size.width as i32,
                                copy.size.height as i32,
                                copy.size.depth as i32,
                                format_desc.external,
                                format_desc.data_type,
                                unpack_data,
                            )
                        };
                    } else {
                        unsafe {
                            gl.tex_sub_image_2d(
                                get_2d_target(dst_target, copy.texture_base.array_layer),
                                copy.texture_base.mip_level as i32,
                                copy.texture_base.origin.x as i32,
                                copy.texture_base.origin.y as i32,
                                copy.size.width as i32,
                                copy.size.height as i32,
                                format_desc.external,
                                format_desc.data_type,
                                unpack_data,
                            )
                        };
                    }
                } else {
                    let bytes_per_row = copy
                        .buffer_layout
                        .bytes_per_row
                        .unwrap_or(copy.size.width * block_size);
                    let minimum_rows_per_image = copy.size.height.div_ceil(block_height);
                    let rows_per_image = copy
                        .buffer_layout
                        .rows_per_image
                        .unwrap_or(minimum_rows_per_image);

                    let bytes_per_image = bytes_per_row * rows_per_image;
                    let minimum_bytes_per_image = bytes_per_row * minimum_rows_per_image;
                    let bytes_in_upload =
                        (bytes_per_image * (copy.size.depth - 1)) + minimum_bytes_per_image;
                    let offset = copy.buffer_layout.offset as u32;

                    let map_state;
                    let unpack_data = match src.raw {
                        Some(buffer) => {
                            unsafe { gl.bind_buffer(glow::PIXEL_UNPACK_BUFFER, Some(buffer)) };
                            unbind_unpack_buffer = true;
                            glow::CompressedPixelUnpackData::BufferRange(
                                offset..offset + bytes_in_upload,
                            )
                        }
                        None => {
                            map_state = lock(&src.map_state);
                            let src_data = &map_state.data.as_ref().unwrap().as_slice()
                                [(offset as usize)..(offset + bytes_in_upload) as usize];
                            glow::CompressedPixelUnpackData::Slice(src_data)
                        }
                    };

                    if is_layered_target(dst_target) {
                        unsafe {
                            gl.compressed_tex_sub_image_3d(
                                dst_target,
                                copy.texture_base.mip_level as i32,
                                copy.texture_base.origin.x as i32,
                                copy.texture_base.origin.y as i32,
                                get_z_offset(dst_target, &copy.texture_base) as i32,
                                copy.size.width as i32,
                                copy.size.height as i32,
                                copy.size.depth as i32,
                                format_desc.internal,
                                unpack_data,
                            )
                        };
                    } else {
                        unsafe {
                            gl.compressed_tex_sub_image_2d(
                                get_2d_target(dst_target, copy.texture_base.array_layer),
                                copy.texture_base.mip_level as i32,
                                copy.texture_base.origin.x as i32,
                                copy.texture_base.origin.y as i32,
                                copy.size.width as i32,
                                copy.size.height as i32,
                                format_desc.internal,
                                unpack_data,
                            )
                        };
                    }
                }
                if unbind_unpack_buffer {
                    unsafe { gl.bind_buffer(glow::PIXEL_UNPACK_BUFFER, None) };
                }
            }
            C::CopyTextureToBuffer {
                src,
                src_target,
                src_format,
                ref dst,
                dst_target: _,
                ref copy,
            } => {
                let block_size = src_format.block_copy_size(None).unwrap();
                if src_format.is_compressed() {
                    log::error!("Not implemented yet: compressed texture copy to buffer");
                    return;
                }
                if src_target == glow::TEXTURE_CUBE_MAP
                    || src_target == glow::TEXTURE_CUBE_MAP_ARRAY
                {
                    log::error!("Not implemented yet: cubemap texture copy to buffer");
                    return;
                }
                let format_desc = self.shared.describe_texture_format(src_format);
                let row_texels = copy
                    .buffer_layout
                    .bytes_per_row
                    .map_or(copy.size.width, |bpr| bpr / block_size);
                let column_texels = copy
                    .buffer_layout
                    .rows_per_image
                    .unwrap_or(copy.size.height);

                if st.read_fbo != ReadFboBinding::CopyFbo {
                    unsafe { gl.bind_framebuffer(glow::READ_FRAMEBUFFER, Some(self.copy_fbo)) };
                    st.read_fbo = ReadFboBinding::CopyFbo;
                }

                let read_pixels = |offset| {
                    let mut map_state;
                    let unpack_data = match dst.raw {
                        Some(buffer) => {
                            unsafe { gl.pixel_store_i32(glow::PACK_ROW_LENGTH, row_texels as i32) };
                            unsafe { gl.bind_buffer(glow::PIXEL_PACK_BUFFER, Some(buffer)) };
                            glow::PixelPackData::BufferOffset(offset as u32)
                        }
                        None => {
                            map_state = lock(&dst.map_state);
                            let dst_data = &mut map_state.data.as_mut().unwrap().as_mut_slice()
                                [offset as usize..];
                            glow::PixelPackData::Slice(Some(dst_data))
                        }
                    };
                    unsafe {
                        gl.read_pixels(
                            copy.texture_base.origin.x as i32,
                            copy.texture_base.origin.y as i32,
                            copy.size.width as i32,
                            copy.size.height as i32,
                            format_desc.external,
                            format_desc.data_type,
                            unpack_data,
                        )
                    };
                };

                match src_target {
                    glow::TEXTURE_2D => {
                        let read_att = FboAttachmentKey::Texture2D {
                            raw: src,
                            target: src_target,
                            mip_level: copy.texture_base.mip_level as i32,
                            sample_count: 1,
                        };
                        if st.copy_fbo_attachment != Some(read_att) {
                            unsafe {
                                read_att.attach(
                                    gl,
                                    glow::READ_FRAMEBUFFER,
                                    glow::COLOR_ATTACHMENT0,
                                );
                            }
                            st.copy_fbo_attachment = Some(read_att);
                            st.copy_fbo_dirty = true;
                        }
                        read_pixels(copy.buffer_layout.offset);
                    }
                    glow::TEXTURE_2D_ARRAY => {
                        let read_att = FboAttachmentKey::TextureLayer {
                            raw: src,
                            mip_level: copy.texture_base.mip_level as i32,
                            layer: copy.texture_base.array_layer as i32,
                        };
                        if st.copy_fbo_attachment != Some(read_att) {
                            unsafe {
                                read_att.attach(
                                    gl,
                                    glow::READ_FRAMEBUFFER,
                                    glow::COLOR_ATTACHMENT0,
                                );
                            }
                            st.copy_fbo_attachment = Some(read_att);
                            st.copy_fbo_dirty = true;
                        }
                        read_pixels(copy.buffer_layout.offset);
                    }
                    glow::TEXTURE_3D => {
                        for z in copy.texture_base.origin.z..copy.size.depth {
                            let read_att = FboAttachmentKey::TextureLayer {
                                raw: src,
                                mip_level: copy.texture_base.mip_level as i32,
                                layer: z as i32,
                            };
                            if st.copy_fbo_attachment != Some(read_att) {
                                unsafe {
                                    read_att.attach(
                                        gl,
                                        glow::READ_FRAMEBUFFER,
                                        glow::COLOR_ATTACHMENT0,
                                    );
                                }
                                st.copy_fbo_attachment = Some(read_att);
                                st.copy_fbo_dirty = true;
                            }
                            let offset = copy.buffer_layout.offset
                                + (z * block_size * row_texels * column_texels) as u64;
                            read_pixels(offset);
                        }
                    }
                    glow::TEXTURE_CUBE_MAP | glow::TEXTURE_CUBE_MAP_ARRAY => unimplemented!(),
                    _ => unreachable!(),
                }
            }
            C::SetIndexBuffer(buffer) => {
                if st.index_buffer != Some(buffer) {
                    unsafe { gl.bind_buffer(glow::ELEMENT_ARRAY_BUFFER, Some(buffer)) };
                    st.index_buffer = Some(buffer);
                    let mut current_index_buffer = self.current_index_buffer.lock();
                    *current_index_buffer = Some(buffer);
                }
            }
            C::BeginQuery(query, target) => {
                unsafe { gl.begin_query(target, query) };
            }
            C::EndQuery(target) => {
                unsafe { gl.end_query(target) };
            }
            C::TimestampQuery(query) => {
                unsafe { gl.query_counter(query, glow::TIMESTAMP) };
            }
            C::CopyQueryResults {
                ref query_range,
                ref dst,
                dst_target,
                dst_offset,
            } => {
                if dst.raw.is_some() {
                    unsafe { self.unbind_index_buffer_if_bound(gl, st) };
                }
                if self
                    .shared
                    .private_caps
                    .contains(PrivateCapabilities::QUERY_BUFFERS)
                    && dst.raw.is_some()
                {
                    unsafe {
                        // We're assuming that the only relevant queries are 8 byte timestamps or
                        // occlusion tests.
                        let query_size = 8;

                        let query_range_size = query_size * query_range.len();

                        let buffer = gl.create_buffer().ok();
                        gl.bind_buffer(glow::QUERY_BUFFER, buffer);
                        gl.buffer_data_size(
                            glow::QUERY_BUFFER,
                            query_range_size as _,
                            glow::STREAM_COPY,
                        );

                        for (i, &query) in queries
                            [query_range.start as usize..query_range.end as usize]
                            .iter()
                            .enumerate()
                        {
                            gl.get_query_parameter_u64_with_offset(
                                query,
                                glow::QUERY_RESULT,
                                query_size * i,
                            )
                        }
                        gl.bind_buffer(dst_target, dst.raw);
                        gl.copy_buffer_sub_data(
                            glow::QUERY_BUFFER,
                            dst_target,
                            0,
                            dst_offset as _,
                            query_range_size as _,
                        );
                        if let Some(buffer) = buffer {
                            gl.delete_buffer(buffer)
                        }
                        if dst_target == glow::ELEMENT_ARRAY_BUFFER {
                            gl.bind_buffer(glow::ELEMENT_ARRAY_BUFFER, None);
                        }
                    }
                } else {
                    let mut temp_query_results = self.temp_query_results.lock();
                    temp_query_results.clear();
                    for &query in
                        queries[query_range.start as usize..query_range.end as usize].iter()
                    {
                        let mut result: u64 = 0;
                        unsafe {
                            if self
                                .shared
                                .private_caps
                                .contains(PrivateCapabilities::QUERY_64BIT)
                            {
                                let result: *mut u64 = &mut result;
                                gl.get_query_parameter_u64_with_offset(
                                    query,
                                    glow::QUERY_RESULT,
                                    result as usize,
                                )
                            } else {
                                result =
                                    gl.get_query_parameter_u32(query, glow::QUERY_RESULT) as u64;
                            }
                        };
                        temp_query_results.push(result);
                    }
                    let query_data = bytemuck::cast_slice(&temp_query_results);
                    match dst.raw {
                        Some(buffer) => {
                            unsafe { gl.bind_buffer(dst_target, Some(buffer)) };
                            unsafe {
                                gl.buffer_sub_data_u8_slice(
                                    dst_target,
                                    dst_offset as i32,
                                    query_data,
                                )
                            };
                            if dst_target == glow::ELEMENT_ARRAY_BUFFER {
                                unsafe { gl.bind_buffer(glow::ELEMENT_ARRAY_BUFFER, None) };
                            }
                        }
                        None => {
                            let mut map_state = lock(&dst.map_state);
                            let data = map_state.data.as_mut().unwrap();
                            let len = query_data.len().min(data.len());
                            data[..len].copy_from_slice(&query_data[..len]);
                        }
                    }
                }
            }
            C::ResetFramebuffer { is_default } => {
                unsafe { self.process_framebuffer_setup(gl, st, is_default, &[], false) };
            }
            C::BindAttachment {
                attachment,
                ref view,
                depth_slice,
                sample_count,
            } => {
                unsafe {
                    self.set_attachment(
                        gl,
                        glow::DRAW_FRAMEBUFFER,
                        attachment,
                        view,
                        depth_slice,
                        sample_count,
                    )
                };
            }
            C::ResolveAttachment {
                attachment,
                ref dst,
                ref size,
            } => {
                let active_draw_fbo = match st.draw_fbo {
                    DrawFboBinding::Cached(fbo) => fbo,
                    _ => self.draw_fbo,
                };
                unsafe { gl.bind_framebuffer(glow::READ_FRAMEBUFFER, Some(active_draw_fbo)) };
                unsafe { gl.read_buffer(attachment) };
                unsafe { gl.bind_framebuffer(glow::DRAW_FRAMEBUFFER, Some(self.copy_fbo)) };
                unsafe {
                    self.set_attachment(
                        gl,
                        glow::DRAW_FRAMEBUFFER,
                        glow::COLOR_ATTACHMENT0,
                        dst,
                        None,
                        1,
                    )
                };
                unsafe {
                    gl.blit_framebuffer(
                        0,
                        0,
                        size.width as i32,
                        size.height as i32,
                        0,
                        0,
                        size.width as i32,
                        size.height as i32,
                        glow::COLOR_BUFFER_BIT,
                        glow::NEAREST,
                    )
                };
                unsafe { gl.bind_framebuffer(glow::READ_FRAMEBUFFER, None) };
                unsafe { gl.bind_framebuffer(glow::DRAW_FRAMEBUFFER, Some(active_draw_fbo)) };
                st.read_fbo = ReadFboBinding::Default;
                st.copy_fbo_attachment = None;
                st.copy_fbo_dirty = true;
            }
            C::InvalidateAttachments(ref list) => {
                if self
                    .shared
                    .private_caps
                    .contains(PrivateCapabilities::INVALIDATE_FRAMEBUFFER)
                {
                    unsafe { gl.invalidate_framebuffer(glow::DRAW_FRAMEBUFFER, list) };
                }
            }
            C::SetDrawColorBuffers(count) => {
                self.draw_buffer_count.store(count, Ordering::Relaxed);
                // Drawpane: `glDrawBuffers` is per-FBO state; skip redundant calls on cached FBOs.
                if let DrawFboBinding::Cached(fbo) = st.draw_fbo {
                    if st.active_draw_fbo_draw_buffers == Some(count) {
                        return;
                    }
                    st.active_draw_fbo_draw_buffers = Some(count);
                    self.shared
                        .fbo_cache
                        .lock()
                        .set_draw_buffer_count(fbo, count);
                }
                let indices = (0..count as u32)
                    .map(|i| glow::COLOR_ATTACHMENT0 + i)
                    .collect::<ArrayVec<_, { crate::MAX_COLOR_ATTACHMENTS }>>();
                unsafe { gl.draw_buffers(&indices) };
            }
            C::ClearColorF {
                draw_buffer,
                ref color,
                is_srgb,
            } => {
                #[cfg(debug_assertions)]
                unsafe {
                    self.debug_verify_gl_state(gl, st);
                }
                if self
                    .shared
                    .workarounds
                    .contains(super::Workarounds::MESA_I915_SRGB_SHADER_CLEAR)
                    && is_srgb
                {
                    unsafe { self.perform_shader_clear(gl, st, draw_buffer, *color) };
                } else {
                    unsafe { gl.clear_buffer_f32_slice(glow::COLOR, draw_buffer, color) };
                }
            }
            C::ClearColorU(draw_buffer, ref color) => {
                #[cfg(debug_assertions)]
                unsafe {
                    self.debug_verify_gl_state(gl, st);
                }
                unsafe { gl.clear_buffer_u32_slice(glow::COLOR, draw_buffer, color) };
            }
            C::ClearColorI(draw_buffer, ref color) => {
                #[cfg(debug_assertions)]
                unsafe {
                    self.debug_verify_gl_state(gl, st);
                }
                unsafe { gl.clear_buffer_i32_slice(glow::COLOR, draw_buffer, color) };
            }
            C::ClearDepth(depth) => {
                #[cfg(debug_assertions)]
                unsafe {
                    self.debug_verify_gl_state(gl, st);
                }
                // Prefer `clear` as `clear_buffer` functions have issues on Sandy Bridge
                // on Windows.
                unsafe {
                    gl.clear_depth_f32(depth);
                    gl.clear(glow::DEPTH_BUFFER_BIT);
                }
            }
            C::ClearStencil(value) => {
                #[cfg(debug_assertions)]
                unsafe {
                    self.debug_verify_gl_state(gl, st);
                }
                // Prefer `clear` as `clear_buffer` functions have issues on Sandy Bridge
                // on Windows.
                unsafe {
                    gl.clear_stencil(value as i32);
                    gl.clear(glow::STENCIL_BUFFER_BIT);
                }
            }
            C::ClearDepthAndStencil(depth, stencil_value) => {
                #[cfg(debug_assertions)]
                unsafe {
                    self.debug_verify_gl_state(gl, st);
                }
                // Prefer `clear` as `clear_buffer` functions have issues on Sandy Bridge
                // on Windows.
                unsafe {
                    gl.clear_depth_f32(depth);
                    gl.clear_stencil(stencil_value as i32);
                    gl.clear(glow::DEPTH_BUFFER_BIT | glow::STENCIL_BUFFER_BIT);
                }
            }
            C::BufferBarrier(raw, usage) => {
                let mut flags = 0;
                if usage.contains(wgt::BufferUses::VERTEX) {
                    flags |= glow::VERTEX_ATTRIB_ARRAY_BARRIER_BIT;
                    unsafe { gl.bind_buffer(glow::ARRAY_BUFFER, Some(raw)) };
                    unsafe { gl.vertex_attrib_pointer_f32(0, 1, glow::BYTE, true, 0, 0) };
                }
                if usage.contains(wgt::BufferUses::INDEX) {
                    flags |= glow::ELEMENT_ARRAY_BARRIER_BIT;
                    unsafe { gl.bind_buffer(glow::ELEMENT_ARRAY_BUFFER, Some(raw)) };
                    st.index_buffer = Some(raw);
                    *self.current_index_buffer.lock() = Some(raw);
                }
                if usage.contains(wgt::BufferUses::UNIFORM) {
                    flags |= glow::UNIFORM_BARRIER_BIT;
                }
                if usage.contains(wgt::BufferUses::INDIRECT) {
                    flags |= glow::COMMAND_BARRIER_BIT;
                    unsafe { gl.bind_buffer(glow::DRAW_INDIRECT_BUFFER, Some(raw)) };
                }
                if usage.contains(wgt::BufferUses::COPY_SRC) {
                    flags |= glow::PIXEL_BUFFER_BARRIER_BIT;
                    unsafe { gl.bind_buffer(glow::PIXEL_UNPACK_BUFFER, Some(raw)) };
                }
                if usage.contains(wgt::BufferUses::COPY_DST) {
                    flags |= glow::PIXEL_BUFFER_BARRIER_BIT;
                    unsafe { gl.bind_buffer(glow::PIXEL_PACK_BUFFER, Some(raw)) };
                }
                if usage.intersects(wgt::BufferUses::MAP_READ | wgt::BufferUses::MAP_WRITE) {
                    flags |= glow::BUFFER_UPDATE_BARRIER_BIT;
                }
                if usage.intersects(
                    wgt::BufferUses::STORAGE_READ_ONLY | wgt::BufferUses::STORAGE_READ_WRITE,
                ) {
                    flags |= glow::SHADER_STORAGE_BARRIER_BIT;
                }
                unsafe { gl.memory_barrier(flags) };
            }
            // because `STORAGE_WRITE_ONLY` and `STORAGE_READ_WRITE` are only states
            // we can transit from due OpenGL memory barriers are used to make _subsequent_
            // operations see changes from the _shader_ side. We filter out usage changes that are
            // does not comes from the shader side in `transition_textures`
            C::TextureBarrier(usage) => {
                let mut flags = 0;
                if usage.contains(wgt::TextureUses::RESOURCE) {
                    flags |= glow::TEXTURE_FETCH_BARRIER_BIT;
                }
                if usage.intersects(
                    wgt::TextureUses::STORAGE_READ_ONLY
                        | wgt::TextureUses::STORAGE_WRITE_ONLY
                        | wgt::TextureUses::STORAGE_READ_WRITE,
                ) {
                    flags |= glow::SHADER_IMAGE_ACCESS_BARRIER_BIT;
                }
                if usage.intersects(wgt::TextureUses::COPY_SRC) {
                    flags |= glow::PIXEL_BUFFER_BARRIER_BIT;
                }
                if usage.contains(wgt::TextureUses::COPY_DST) {
                    flags |= glow::TEXTURE_UPDATE_BARRIER_BIT;
                }
                if usage.intersects(
                    wgt::TextureUses::COLOR_TARGET
                        | wgt::TextureUses::DEPTH_STENCIL_READ
                        | wgt::TextureUses::DEPTH_STENCIL_WRITE,
                ) {
                    flags |= glow::FRAMEBUFFER_BARRIER_BIT;
                }
                unsafe { gl.memory_barrier(flags) };
            }
            C::SetViewport {
                ref rect,
                ref depth,
            } => {
                let vp = [rect.x, rect.y, rect.w, rect.h];
                if st.viewport != Some(vp) {
                    unsafe { gl.viewport(rect.x, rect.y, rect.w, rect.h) };
                    st.viewport = Some(vp);
                }
                let dr = (depth.start.to_bits(), depth.end.to_bits());
                if st.depth_range != Some(dr) {
                    unsafe { gl.depth_range_f32(depth.start, depth.end) };
                    st.depth_range = Some(dr);
                }
            }
            C::SetScissor(ref rect) => {
                let sc = [rect.x, rect.y, rect.w, rect.h];
                if st.scissor_rect != Some(sc) {
                    unsafe { gl.scissor(rect.x, rect.y, rect.w, rect.h) };
                    st.scissor_rect = Some(sc);
                }
                if st.scissor_test != Some(true) {
                    unsafe { gl.enable(glow::SCISSOR_TEST) };
                    st.scissor_test = Some(true);
                }
            }
            C::SetStencilFunc {
                face,
                function,
                reference,
                read_mask,
            } => {
                unsafe { gl.stencil_func_separate(face, function, reference as i32, read_mask) };
            }
            C::SetStencilOps {
                face,
                write_mask,
                ref ops,
            } => {
                unsafe { gl.stencil_mask_separate(face, write_mask) };
                unsafe { gl.stencil_op_separate(face, ops.fail, ops.depth_fail, ops.pass) };
                if write_mask != !0 {
                    st.stencil_mask_all = Some(false);
                }
            }
            C::SetVertexAttribute {
                buffer,
                ref buffer_desc,
                attribute_desc: ref vat,
            } => {
                unsafe { gl.bind_buffer(glow::ARRAY_BUFFER, buffer) };
                unsafe { gl.enable_vertex_attrib_array(vat.location) };

                if buffer.is_none() {
                    match vat.format_desc.attrib_kind {
                        super::VertexAttribKind::Float => unsafe {
                            gl.vertex_attrib_format_f32(
                                vat.location,
                                vat.format_desc.element_count,
                                vat.format_desc.element_format,
                                true, // always normalized
                                vat.offset,
                            )
                        },
                        super::VertexAttribKind::Integer => unsafe {
                            gl.vertex_attrib_format_i32(
                                vat.location,
                                vat.format_desc.element_count,
                                vat.format_desc.element_format,
                                vat.offset,
                            )
                        },
                    }

                    //Note: there is apparently a bug on AMD 3500U:
                    // this call is ignored if the current array is disabled.
                    unsafe { gl.vertex_attrib_binding(vat.location, vat.buffer_index) };
                } else {
                    match vat.format_desc.attrib_kind {
                        super::VertexAttribKind::Float => unsafe {
                            gl.vertex_attrib_pointer_f32(
                                vat.location,
                                vat.format_desc.element_count,
                                vat.format_desc.element_format,
                                true, // always normalized
                                buffer_desc.stride as i32,
                                vat.offset as i32,
                            )
                        },
                        super::VertexAttribKind::Integer => unsafe {
                            gl.vertex_attrib_pointer_i32(
                                vat.location,
                                vat.format_desc.element_count,
                                vat.format_desc.element_format,
                                buffer_desc.stride as i32,
                                vat.offset as i32,
                            )
                        },
                    }
                    unsafe { gl.vertex_attrib_divisor(vat.location, buffer_desc.step as u32) };
                }
            }
            C::UnsetVertexAttribute(location) => {
                unsafe { gl.disable_vertex_attrib_array(location) };
            }
            C::SetVertexBuffer {
                index,
                ref buffer,
                ref buffer_desc,
            } => {
                unsafe { gl.vertex_binding_divisor(index, buffer_desc.step as u32) };
                unsafe {
                    gl.bind_vertex_buffer(
                        index,
                        Some(buffer.raw),
                        buffer.offset as i32,
                        buffer_desc.stride as i32,
                    )
                };
            }
            C::SetDepth(ref depth) => {
                if st.depth_func != Some(depth.function) {
                    unsafe { gl.depth_func(depth.function) };
                    st.depth_func = Some(depth.function);
                }
                if st.depth_mask != Some(depth.mask) {
                    unsafe { gl.depth_mask(depth.mask) };
                    st.depth_mask = Some(depth.mask);
                }
            }
            C::SetDepthBias(bias) => {
                if bias.is_enabled() {
                    if st.polygon_offset_enabled != Some(true) {
                        unsafe { gl.enable(glow::POLYGON_OFFSET_FILL) };
                        st.polygon_offset_enabled = Some(true);
                    }
                    unsafe { gl.polygon_offset(bias.slope_scale, bias.constant as f32) };
                } else if st.polygon_offset_enabled != Some(false) {
                    unsafe { gl.disable(glow::POLYGON_OFFSET_FILL) };
                    st.polygon_offset_enabled = Some(false);
                }
            }
            C::ConfigureDepthStencil(aspects) => {
                let want_depth = aspects.contains(crate::FormatAspects::DEPTH);
                if st.depth_test != Some(want_depth) {
                    if want_depth {
                        unsafe { gl.enable(glow::DEPTH_TEST) };
                    } else {
                        unsafe { gl.disable(glow::DEPTH_TEST) };
                    }
                    st.depth_test = Some(want_depth);
                }
                let want_stencil = aspects.contains(crate::FormatAspects::STENCIL);
                if st.stencil_test != Some(want_stencil) {
                    if want_stencil {
                        unsafe { gl.enable(glow::STENCIL_TEST) };
                    } else {
                        unsafe { gl.disable(glow::STENCIL_TEST) };
                    }
                    st.stencil_test = Some(want_stencil);
                }
            }
            C::SetAlphaToCoverage(enabled) => {
                if st.alpha_to_coverage != Some(enabled) {
                    if enabled {
                        unsafe { gl.enable(glow::SAMPLE_ALPHA_TO_COVERAGE) };
                    } else {
                        unsafe { gl.disable(glow::SAMPLE_ALPHA_TO_COVERAGE) };
                    }
                    st.alpha_to_coverage = Some(enabled);
                }
            }
            C::SetProgram(program) => {
                if st.program != Some(Some(program)) {
                    unsafe { gl.use_program(Some(program)) };
                    st.program = Some(Some(program));
                }
            }
            C::SetPrimitive(ref state) => {
                if st.primitive.as_ref() != Some(state) {
                    if st.primitive.as_ref().map(|p| p.front_face) != Some(state.front_face) {
                        unsafe { gl.front_face(state.front_face) };
                    }
                    if state.cull_face != 0 {
                        if st.cull_face_enabled != Some(true) {
                            unsafe { gl.enable(glow::CULL_FACE) };
                            st.cull_face_enabled = Some(true);
                        }
                        if st.primitive.as_ref().map(|p| p.cull_face) != Some(state.cull_face) {
                            unsafe { gl.cull_face(state.cull_face) };
                        }
                    } else if st.cull_face_enabled != Some(false) {
                        unsafe { gl.disable(glow::CULL_FACE) };
                        st.cull_face_enabled = Some(false);
                    }
                    if self.features.contains(wgt::Features::DEPTH_CLIP_CONTROL)
                        && st.depth_clamp != Some(state.unclipped_depth)
                    {
                        //Note: this is a bit tricky, since we are controlling the clip, not the clamp.
                        if state.unclipped_depth {
                            unsafe { gl.enable(glow::DEPTH_CLAMP) };
                        } else {
                            unsafe { gl.disable(glow::DEPTH_CLAMP) };
                        }
                        st.depth_clamp = Some(state.unclipped_depth);
                    }
                    // POLYGON_MODE_LINE also implies POLYGON_MODE_POINT
                    if self.features.contains(wgt::Features::POLYGON_MODE_LINE)
                        && st.primitive.as_ref().map(|p| p.polygon_mode) != Some(state.polygon_mode)
                    {
                        unsafe { gl.polygon_mode(glow::FRONT_AND_BACK, state.polygon_mode) };
                    }
                    st.primitive = Some(state.clone());
                }
            }
            C::SetBlendConstant(c) => {
                unsafe { gl.blend_color(c[0], c[1], c[2], c[3]) };
            }
            C::SetColorTarget {
                draw_buffer_index,
                desc: ref target_desc,
            } => {
                use wgt::ColorWrites as Cw;
                let super::ColorTargetDesc { mask, ref blend } = *target_desc;
                if let Some(index) = draw_buffer_index {
                    unsafe {
                        gl.color_mask_draw_buffer(
                            index,
                            mask.contains(Cw::RED),
                            mask.contains(Cw::GREEN),
                            mask.contains(Cw::BLUE),
                            mask.contains(Cw::ALPHA),
                        )
                    };
                    if let Some(ref blend) = *blend {
                        unsafe { gl.enable_draw_buffer(glow::BLEND, index) };
                        if blend.color != blend.alpha {
                            unsafe {
                                gl.blend_equation_separate_draw_buffer(
                                    index,
                                    blend.color.equation,
                                    blend.alpha.equation,
                                )
                            };
                            unsafe {
                                gl.blend_func_separate_draw_buffer(
                                    index,
                                    blend.color.src,
                                    blend.color.dst,
                                    blend.alpha.src,
                                    blend.alpha.dst,
                                )
                            };
                        } else {
                            unsafe { gl.blend_equation_draw_buffer(index, blend.color.equation) };
                            unsafe {
                                gl.blend_func_draw_buffer(index, blend.color.src, blend.color.dst)
                            };
                        }
                    } else {
                        unsafe { gl.disable_draw_buffer(glow::BLEND, index) };
                    }
                    st.uniform_color_target = None;
                    st.blend_all_disabled = false;
                    if mask != Cw::ALL {
                        st.color_mask_all_true = Some(false);
                    }
                } else if st.uniform_color_target.as_ref() != Some(target_desc) {
                    if mask == Cw::ALL {
                        if st.color_mask_all_true != Some(true) {
                            unsafe { gl.color_mask(true, true, true, true) };
                            st.color_mask_all_true = Some(true);
                        }
                    } else {
                        unsafe {
                            gl.color_mask(
                                mask.contains(Cw::RED),
                                mask.contains(Cw::GREEN),
                                mask.contains(Cw::BLUE),
                                mask.contains(Cw::ALPHA),
                            )
                        };
                        st.color_mask_all_true = Some(false);
                    }
                    let prev_blend = st
                        .uniform_color_target
                        .as_ref()
                        .and_then(|t| t.blend.as_ref());
                    if let Some(ref blend) = *blend {
                        if prev_blend != Some(blend) {
                            if st.blend_all_disabled || prev_blend.is_none() {
                                unsafe { gl.enable(glow::BLEND) };
                            }
                            st.blend_all_disabled = false;
                            if blend.color != blend.alpha {
                                unsafe {
                                    gl.blend_equation_separate(
                                        blend.color.equation,
                                        blend.alpha.equation,
                                    )
                                };
                                unsafe {
                                    gl.blend_func_separate(
                                        blend.color.src,
                                        blend.color.dst,
                                        blend.alpha.src,
                                        blend.alpha.dst,
                                    )
                                };
                            } else {
                                unsafe { gl.blend_equation(blend.color.equation) };
                                unsafe { gl.blend_func(blend.color.src, blend.color.dst) };
                            }
                        }
                    } else if !st.blend_all_disabled {
                        unsafe { gl.disable(glow::BLEND) };
                        st.blend_all_disabled = true;
                    }
                    st.uniform_color_target = Some(target_desc.clone());
                }
            }
            C::BindBuffer {
                target,
                slot,
                buffer,
                offset,
                size,
            } => {
                unsafe { gl.bind_buffer_range(target, slot, Some(buffer), offset, size) };
            }
            C::BindSampler(texture_index, sampler) => {
                unsafe { gl.bind_sampler(texture_index, sampler) };
            }
            C::BindTexture {
                slot,
                texture,
                target,
                aspects,
                ref mip_levels,
            } => {
                if st.active_texture != Some(slot) {
                    unsafe { gl.active_texture(glow::TEXTURE0 + slot) };
                    st.active_texture = Some(slot);
                }
                unsafe { gl.bind_texture(target, Some(texture)) };

                unsafe {
                    gl.tex_parameter_i32(target, glow::TEXTURE_BASE_LEVEL, mip_levels.start as i32)
                };
                unsafe {
                    gl.tex_parameter_i32(
                        target,
                        glow::TEXTURE_MAX_LEVEL,
                        (mip_levels.end - 1) as i32,
                    )
                };

                let version = gl.version();
                let is_min_es_3_1 = version.is_embedded && (version.major, version.minor) >= (3, 1);
                let is_min_4_3 = !version.is_embedded && (version.major, version.minor) >= (4, 3);
                if is_min_es_3_1 || is_min_4_3 {
                    let mode = match aspects {
                        crate::FormatAspects::DEPTH => Some(glow::DEPTH_COMPONENT),
                        crate::FormatAspects::STENCIL => Some(glow::STENCIL_INDEX),
                        _ => None,
                    };
                    if let Some(mode) = mode {
                        unsafe {
                            gl.tex_parameter_i32(
                                target,
                                glow::DEPTH_STENCIL_TEXTURE_MODE,
                                mode as _,
                            )
                        };
                    }
                }
            }
            C::BindImage { slot, ref binding } => {
                unsafe {
                    gl.bind_image_texture(
                        slot,
                        Some(binding.raw),
                        binding.mip_level as i32,
                        binding.array_layer.is_none(),
                        binding.array_layer.unwrap_or_default() as i32,
                        binding.access,
                        binding.format,
                    )
                };
            }
            C::InsertDebugMarker(ref range) => {
                let marker = extract_marker(data_bytes, range);
                unsafe {
                    if self
                        .shared
                        .private_caps
                        .contains(PrivateCapabilities::DEBUG_FNS)
                    {
                        gl.debug_message_insert(
                            glow::DEBUG_SOURCE_APPLICATION,
                            glow::DEBUG_TYPE_MARKER,
                            DEBUG_ID,
                            glow::DEBUG_SEVERITY_NOTIFICATION,
                            to_debug_str(marker),
                        )
                    }
                };
            }
            C::PushDebugGroup(ref range) => {
                let marker = extract_marker(data_bytes, range);
                unsafe {
                    if self
                        .shared
                        .private_caps
                        .contains(PrivateCapabilities::DEBUG_FNS)
                    {
                        gl.push_debug_group(
                            glow::DEBUG_SOURCE_APPLICATION,
                            DEBUG_ID,
                            to_debug_str(marker),
                        )
                    }
                };
            }
            C::PopDebugGroup => {
                unsafe {
                    if self
                        .shared
                        .private_caps
                        .contains(PrivateCapabilities::DEBUG_FNS)
                    {
                        gl.pop_debug_group()
                    }
                };
            }
            C::SetImmediates {
                ref uniform,
                offset,
            } => {
                fn get_data<T, const COUNT: usize>(data: &[u8], offset: u32) -> [T; COUNT]
                where
                    [T; COUNT]: bytemuck::AnyBitPattern,
                {
                    let data_required = size_of::<T>() * COUNT;
                    let raw = &data[(offset as usize)..][..data_required];
                    bytemuck::pod_read_unaligned(raw)
                }

                let location = Some(&uniform.location);
                use nt::glsl::{GlslScalar, GlslUniformType, GlslVectorSize};
                match uniform.ty {
                    //
                    // --- Float 1-4 Component ---
                    //
                    GlslUniformType::Scalar(GlslScalar::F32) => {
                        let data = get_data::<f32, 1>(data_bytes, offset)[0];
                        unsafe { gl.uniform_1_f32(location, data) };
                    }
                    GlslUniformType::Vector {
                        size: GlslVectorSize::Bi,
                        scalar: GlslScalar::F32,
                    } => {
                        let data = &get_data::<f32, 2>(data_bytes, offset);
                        unsafe { gl.uniform_2_f32_slice(location, data) };
                    }
                    GlslUniformType::Vector {
                        size: GlslVectorSize::Tri,
                        scalar: GlslScalar::F32,
                    } => {
                        let data = &get_data::<f32, 3>(data_bytes, offset);
                        unsafe { gl.uniform_3_f32_slice(location, data) };
                    }
                    GlslUniformType::Vector {
                        size: GlslVectorSize::Quad,
                        scalar: GlslScalar::F32,
                    } => {
                        let data = &get_data::<f32, 4>(data_bytes, offset);
                        unsafe { gl.uniform_4_f32_slice(location, data) };
                    }

                    //
                    // --- Int 1-4 Component ---
                    //
                    GlslUniformType::Scalar(GlslScalar::I32) => {
                        let data = get_data::<i32, 1>(data_bytes, offset)[0];
                        unsafe { gl.uniform_1_i32(location, data) };
                    }
                    GlslUniformType::Vector {
                        size: GlslVectorSize::Bi,
                        scalar: GlslScalar::I32,
                    } => {
                        let data = &get_data::<i32, 2>(data_bytes, offset);
                        unsafe { gl.uniform_2_i32_slice(location, data) };
                    }
                    GlslUniformType::Vector {
                        size: GlslVectorSize::Tri,
                        scalar: GlslScalar::I32,
                    } => {
                        let data = &get_data::<i32, 3>(data_bytes, offset);
                        unsafe { gl.uniform_3_i32_slice(location, data) };
                    }
                    GlslUniformType::Vector {
                        size: GlslVectorSize::Quad,
                        scalar: GlslScalar::I32,
                    } => {
                        let data = &get_data::<i32, 4>(data_bytes, offset);
                        unsafe { gl.uniform_4_i32_slice(location, data) };
                    }

                    //
                    // --- Uint 1-4 Component ---
                    //
                    GlslUniformType::Scalar(GlslScalar::U32) => {
                        let data = get_data::<u32, 1>(data_bytes, offset)[0];
                        unsafe { gl.uniform_1_u32(location, data) };
                    }
                    GlslUniformType::Vector {
                        size: GlslVectorSize::Bi,
                        scalar: GlslScalar::U32,
                    } => {
                        let data = &get_data::<u32, 2>(data_bytes, offset);
                        unsafe { gl.uniform_2_u32_slice(location, data) };
                    }
                    GlslUniformType::Vector {
                        size: GlslVectorSize::Tri,
                        scalar: GlslScalar::U32,
                    } => {
                        let data = &get_data::<u32, 3>(data_bytes, offset);
                        unsafe { gl.uniform_3_u32_slice(location, data) };
                    }
                    GlslUniformType::Vector {
                        size: GlslVectorSize::Quad,
                        scalar: GlslScalar::U32,
                    } => {
                        let data = &get_data::<u32, 4>(data_bytes, offset);
                        unsafe { gl.uniform_4_u32_slice(location, data) };
                    }

                    //
                    // --- Matrix 2xR ---
                    //
                    GlslUniformType::Matrix {
                        columns: GlslVectorSize::Bi,
                        rows: GlslVectorSize::Bi,
                        scalar: GlslScalar::F32,
                    } => {
                        let data = &get_data::<f32, 4>(data_bytes, offset);
                        unsafe { gl.uniform_matrix_2_f32_slice(location, false, data) };
                    }
                    GlslUniformType::Matrix {
                        columns: GlslVectorSize::Bi,
                        rows: GlslVectorSize::Tri,
                        scalar: GlslScalar::F32,
                    } => {
                        // repack 2 vec3s into 6 values.
                        let unpacked_data = &get_data::<f32, 8>(data_bytes, offset);
                        #[rustfmt::skip]
                        let packed_data = [
                            unpacked_data[0], unpacked_data[1], unpacked_data[2],
                            unpacked_data[4], unpacked_data[5], unpacked_data[6],
                        ];
                        unsafe { gl.uniform_matrix_2x3_f32_slice(location, false, &packed_data) };
                    }
                    GlslUniformType::Matrix {
                        columns: GlslVectorSize::Bi,
                        rows: GlslVectorSize::Quad,
                        scalar: GlslScalar::F32,
                    } => {
                        let data = &get_data::<f32, 8>(data_bytes, offset);
                        unsafe { gl.uniform_matrix_2x4_f32_slice(location, false, data) };
                    }

                    //
                    // --- Matrix 3xR ---
                    //
                    GlslUniformType::Matrix {
                        columns: GlslVectorSize::Tri,
                        rows: GlslVectorSize::Bi,
                        scalar: GlslScalar::F32,
                    } => {
                        let data = &get_data::<f32, 6>(data_bytes, offset);
                        unsafe { gl.uniform_matrix_3x2_f32_slice(location, false, data) };
                    }
                    GlslUniformType::Matrix {
                        columns: GlslVectorSize::Tri,
                        rows: GlslVectorSize::Tri,
                        scalar: GlslScalar::F32,
                    } => {
                        // repack 3 vec3s into 9 values.
                        let unpacked_data = &get_data::<f32, 12>(data_bytes, offset);
                        #[rustfmt::skip]
                        let packed_data = [
                            unpacked_data[0], unpacked_data[1], unpacked_data[2],
                            unpacked_data[4], unpacked_data[5], unpacked_data[6],
                            unpacked_data[8], unpacked_data[9], unpacked_data[10],
                        ];
                        unsafe { gl.uniform_matrix_3_f32_slice(location, false, &packed_data) };
                    }
                    GlslUniformType::Matrix {
                        columns: GlslVectorSize::Tri,
                        rows: GlslVectorSize::Quad,
                        scalar: GlslScalar::F32,
                    } => {
                        let data = &get_data::<f32, 12>(data_bytes, offset);
                        unsafe { gl.uniform_matrix_3x4_f32_slice(location, false, data) };
                    }

                    //
                    // --- Matrix 4xR ---
                    //
                    GlslUniformType::Matrix {
                        columns: GlslVectorSize::Quad,
                        rows: GlslVectorSize::Bi,
                        scalar: GlslScalar::F32,
                    } => {
                        let data = &get_data::<f32, 8>(data_bytes, offset);
                        unsafe { gl.uniform_matrix_4x2_f32_slice(location, false, data) };
                    }
                    GlslUniformType::Matrix {
                        columns: GlslVectorSize::Quad,
                        rows: GlslVectorSize::Tri,
                        scalar: GlslScalar::F32,
                    } => {
                        // repack 4 vec3s into 12 values.
                        let unpacked_data = &get_data::<f32, 16>(data_bytes, offset);
                        #[rustfmt::skip]
                        let packed_data = [
                            unpacked_data[0], unpacked_data[1], unpacked_data[2],
                            unpacked_data[4], unpacked_data[5], unpacked_data[6],
                            unpacked_data[8], unpacked_data[9], unpacked_data[10],
                            unpacked_data[12], unpacked_data[13], unpacked_data[14],
                        ];
                        unsafe { gl.uniform_matrix_4x3_f32_slice(location, false, &packed_data) };
                    }
                    GlslUniformType::Matrix {
                        columns: GlslVectorSize::Quad,
                        rows: GlslVectorSize::Quad,
                        scalar: GlslScalar::F32,
                    } => {
                        let data = &get_data::<f32, 16>(data_bytes, offset);
                        unsafe { gl.uniform_matrix_4_f32_slice(location, false, data) };
                    }
                    _ => panic!("Unsupported uniform datatype: {:?}!", uniform.ty),
                }
            }
            C::SetClipDistances {
                old_count,
                new_count,
            } => {
                // Disable clip planes that are no longer active
                for i in new_count..old_count {
                    unsafe { gl.disable(glow::CLIP_DISTANCE0 + i) };
                }

                // Enable clip planes that are now active
                for i in old_count..new_count {
                    unsafe { gl.enable(glow::CLIP_DISTANCE0 + i) };
                }
                st.clip_distance_count = new_count;
            }
        }
    }
}

impl crate::Queue for super::Queue {
    type A = super::Api;

    unsafe fn submit(
        &self,
        command_buffers: &[&super::CommandBuffer],
        _surface_textures: &[&super::Texture],
        (signal_fence, signal_value): (&super::Fence, crate::FenceValue),
    ) -> Result<(), crate::DeviceError> {
        let shared = Arc::clone(&self.shared);
        let gl = &shared.context.lock();
        let debug_fns = self
            .shared
            .private_caps
            .contains(PrivateCapabilities::DEBUG_FNS);
        // Drawpane: skip empty command buffers, reset full GL state once per submit (protecting
        // against external GL use, Surface::present, resource creation, or context restore), and
        // maintain per-submit shadow state across command buffers.
        let mut submit_state: Option<SubmitState> = None;

        for cmd_buf in command_buffers.iter() {
            if cmd_buf.commands.is_empty() {
                continue;
            }
            let st = match submit_state {
                Some(ref mut st) => {
                    unsafe { self.reset_cmd_buf_state(gl, st) };
                    st
                }
                None => {
                    unsafe { self.reset_state(gl) };
                    submit_state.insert(SubmitState::after_reset(
                        self.features.contains(wgt::Features::DEPTH_CLIP_CONTROL),
                    ))
                }
            };
            if let Some(ref label) = cmd_buf.label {
                if debug_fns {
                    unsafe {
                        gl.push_debug_group(
                            glow::DEBUG_SOURCE_APPLICATION,
                            DEBUG_ID,
                            to_debug_str(label),
                        )
                    };
                }
            }

            let mut idx = 0;
            while idx < cmd_buf.commands.len() {
                if let C::ResetFramebuffer { is_default } = cmd_buf.commands[idx] {
                    let bind_start = idx + 1;
                    let mut bind_end = bind_start;
                    while matches!(
                        cmd_buf.commands.get(bind_end),
                        Some(C::BindAttachment { .. })
                    ) {
                        bind_end += 1;
                    }
                    let next_is_scissor =
                        matches!(cmd_buf.commands.get(bind_end), Some(C::SetScissor(_)));
                    unsafe {
                        self.process_framebuffer_setup(
                            gl,
                            st,
                            is_default,
                            &cmd_buf.commands[bind_start..bind_end],
                            next_is_scissor,
                        );
                    }
                    idx = bind_end;
                    continue;
                }
                unsafe {
                    self.process(
                        gl,
                        st,
                        &cmd_buf.commands[idx],
                        &cmd_buf.data_bytes,
                        &cmd_buf.queries,
                    )
                };
                idx += 1;
            }

            if cmd_buf.label.is_some() && debug_fns {
                unsafe { gl.pop_debug_group() };
            }
        }

        if let Some(ref mut st) = submit_state {
            unsafe { self.finish_submit_state(gl, st) };
        }

        signal_fence.maintain(gl);
        signal_fence.signal(gl, signal_value)?;

        // This is extremely important. If we don't flush, the above fences may never
        // be signaled, particularly in headless contexts. Headed contexts will
        // often flush every so often, but headless contexts may not.
        unsafe { gl.flush() };

        Ok(())
    }

    unsafe fn present(
        &self,
        surface: &super::Surface,
        texture: super::Texture,
    ) -> Result<(), crate::SurfaceError> {
        unsafe { surface.present(texture, &self.shared.context) }
    }

    unsafe fn get_timestamp_period(&self) -> f32 {
        1.0
    }

    unsafe fn wait_for_idle(&self) -> Result<(), crate::DeviceError> {
        let gl = &self.shared.context.lock();
        unsafe { gl.finish() };
        Ok(())
    }
}

#[cfg(send_sync)]
unsafe impl Sync for super::Queue {}
#[cfg(send_sync)]
unsafe impl Send for super::Queue {}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn diff_fbo_slots_only_touches_changed_and_removed_slots() {
        let mut old_color = [None; crate::MAX_COLOR_ATTACHMENTS];
        old_color[0] = Some(1u32);
        old_color[1] = Some(2u32);
        let old_ds = Some((glow::DEPTH_ATTACHMENT, 10u32));

        // Transition: 2 color + depth -> 1 color (changed slot 0, removed slot 1 and depth).
        let mut new_color = [None; crate::MAX_COLOR_ATTACHMENTS];
        new_color[0] = Some(3u32);
        let new_ds = None;

        let mut ops = Vec::new();
        diff_fbo_slots(&old_color, old_ds, &new_color, new_ds, |op| ops.push(op));
        assert_eq!(
            ops,
            vec![
                FboSlotOp::Attach(glow::COLOR_ATTACHMENT0, 3u32),
                FboSlotOp::Detach(glow::COLOR_ATTACHMENT1),
                FboSlotOp::Detach(glow::DEPTH_ATTACHMENT),
            ]
        );
    }

    #[test]
    fn diff_fbo_slots_is_noop_when_identical() {
        let mut color = [None; crate::MAX_COLOR_ATTACHMENTS];
        color[0] = Some(7u32);
        let ds = Some((glow::DEPTH_STENCIL_ATTACHMENT, 9u32));

        let mut ops = Vec::new();
        diff_fbo_slots(&color, ds, &color, ds, |op| ops.push(op));
        assert!(ops.is_empty());
    }

    #[test]
    fn diff_fbo_slots_detaches_combined_point_when_depth_aspect_changes() {
        let color = [None; crate::MAX_COLOR_ATTACHMENTS];
        let old_ds = Some((glow::DEPTH_STENCIL_ATTACHMENT, 9u32));
        let new_ds = Some((glow::DEPTH_ATTACHMENT, 11u32));

        let mut ops = Vec::new();
        diff_fbo_slots(&color, old_ds, &color, new_ds, |op| ops.push(op));
        assert_eq!(
            ops,
            vec![
                FboSlotOp::Detach(glow::DEPTH_STENCIL_ATTACHMENT),
                FboSlotOp::Attach(glow::DEPTH_ATTACHMENT, 11u32),
            ]
        );
    }

    #[test]
    fn submit_state_after_reset_matches_reset_state_invariants() {
        let st = SubmitState::after_reset(true);
        assert_eq!(st.program, Some(None));
        assert_eq!(st.draw_fbo, DrawFboBinding::Default);
        assert_eq!(st.read_fbo, ReadFboBinding::Default);
        assert_eq!(st.depth_test, Some(false));
        assert_eq!(st.stencil_test, Some(false));
        assert_eq!(st.scissor_test, Some(false));
        assert_eq!(st.cull_face_enabled, Some(false));
        assert_eq!(st.polygon_offset_enabled, Some(false));
        assert_eq!(st.alpha_to_coverage, Some(false));
        assert_eq!(st.depth_clamp, Some(false));
        assert!(st.blend_all_disabled);
        assert_eq!(st.color_mask_all_true, None);
        assert_eq!(st.depth_mask, None);
        assert_eq!(st.stencil_mask_all, None);
        assert_eq!(st.viewport, None);
        assert_eq!(st.scissor_rect, None);
        assert_eq!(st.index_buffer, None);
    }
}
