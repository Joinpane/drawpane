//! Decision 0040's spike: one engine for the canvas and for headless renders. See README.md.

pub mod dl;
pub mod exec;
pub mod glass;

#[cfg(feature = "cpu")]
pub mod cpu;
#[cfg(feature = "gpu")]
pub mod gpu;

use wasm_bindgen::prelude::*;

/// A CPU render: premultiplied RGBA8 pixels, then how the list ran.
#[wasm_bindgen]
pub struct CpuFrame {
    pixels: Vec<u8>,
    pub width: u32,
    pub height: u32,
    pub ops: u32,
    pub flushes: u32,
    pub apart: u32,
    pub glass: u32,
    pub ms_main: f64,
    pub ms_apart: f64,
    pub ms_composite: f64,
    pub ms_glass: f64,
}

#[wasm_bindgen]
impl CpuFrame {
    /// The pixels, unpremultiplied (as a PNG or ImageData holds them).
    pub fn rgba(&self) -> Vec<u8> {
        unpremultiply(self.pixels.clone())
    }
}

fn unpremultiply(mut out: Vec<u8>) -> Vec<u8> {
    for p in out.chunks_exact_mut(4) {
        let a = u32::from(p[3]);
        if a != 0 && a != 255 {
            for c in &mut p[..3] {
                *c = ((u32::from(*c) * 255 + a / 2) / a).min(255) as u8;
            }
        }
    }
    out
}

/// Draws a display list with vello_cpu and the CPU kernels.
#[cfg(feature = "cpu")]
#[wasm_bindgen(js_name = renderCpu)]
pub fn render_cpu(list: &[u8]) -> Result<CpuFrame, JsError> {
    let list = dl::decode(list).map_err(|e| JsError::new(&e))?;
    let (pixmap, stats) = cpu::render(&list).map_err(|e| JsError::new(&e))?;
    Ok(CpuFrame {
        width: u32::from(pixmap.width()),
        height: u32::from(pixmap.height()),
        pixels: pixmap.data_as_u8_slice().to_vec(),
        ops: stats.ops,
        flushes: stats.flushes,
        apart: stats.apart,
        glass: stats.glass,
        ms_main: stats.ms_main,
        ms_apart: stats.ms_apart,
        ms_composite: stats.ms_composite,
        ms_glass: stats.ms_glass,
    })
}

/// Bytes of WebAssembly memory now (it only grows, so after a render it's the peak).
#[wasm_bindgen(js_name = memoryBytes)]
pub fn memory_bytes() -> usize {
    #[cfg(target_arch = "wasm32")]
    {
        core::arch::wasm32::memory_size(0) * 65536
    }
    #[cfg(not(target_arch = "wasm32"))]
    {
        0
    }
}

/// The GPU engine on WebGPU, for the page: one page-sized set of targets.
#[cfg(feature = "gpu")]
#[wasm_bindgen]
pub struct GpuEngine {
    gpu: std::rc::Rc<std::cell::RefCell<gpu::Gpu>>,
    adapter: String,
}

/// What a GPU render did: counts, and how many command buffers it submitted.
#[cfg(feature = "gpu")]
#[wasm_bindgen]
pub struct GpuFrame {
    pub ops: u32,
    pub flushes: u32,
    pub apart: u32,
    pub glass: u32,
    pub submits: u32,
}

#[cfg(feature = "gpu")]
#[wasm_bindgen]
impl GpuEngine {
    /// A WebGPU device through wgpu, and targets `width` × `height`.
    pub async fn create(width: u16, height: u16) -> Result<GpuEngine, JsError> {
        let instance = wgpu::Instance::new(wgpu::InstanceDescriptor {
            display: None,
            backends: wgpu::Backends::BROWSER_WEBGPU,
            flags: wgpu::InstanceFlags::default(),
            memory_budget_thresholds: wgpu::MemoryBudgetThresholds::default(),
            backend_options: wgpu::BackendOptions::default(),
        });
        let adapter = instance
            .request_adapter(&wgpu::RequestAdapterOptions {
                power_preference: wgpu::PowerPreference::HighPerformance,
                force_fallback_adapter: false,
                compatible_surface: None,
                ..Default::default()
            })
            .await
            .map_err(|e| JsError::new(&format!("no WebGPU adapter: {e}")))?;
        let info = adapter.get_info();
        let (device, queue) = adapter
            .request_device(&wgpu::DeviceDescriptor {
                label: None,
                required_features: wgpu::Features::empty(),
                required_limits: wgpu::Limits::default(),
                ..Default::default()
            })
            .await
            .map_err(|e| JsError::new(&format!("no WebGPU device: {e}")))?;
        Ok(GpuEngine {
            gpu: std::rc::Rc::new(std::cell::RefCell::new(gpu::Gpu::new(device, queue, width, height))),
            adapter: format!("{} ({:?}, {:?})", info.name, info.device_type, info.backend),
        })
    }

    /// What wgpu says the adapter is.
    #[wasm_bindgen(getter)]
    pub fn adapter(&self) -> String {
        self.adapter.clone()
    }

    /// Whether page segments are laid on by vello_gpu's own source-over (the default; else by the kernel).
    #[wasm_bindgen(js_name = setVelloSrcOver)]
    pub fn set_vello_src_over(&self, on: bool) {
        self.gpu.borrow_mut().src_over = on;
    }

    /// Encodes and submits a display list; the GPU may still be drawing when this returns.
    pub fn render(&self, list: &[u8]) -> Result<GpuFrame, JsError> {
        let list = dl::decode(list).map_err(|e| JsError::new(&e))?;
        let mut gpu = self.gpu.borrow_mut();
        if list.width != gpu.width || list.height != gpu.height {
            return Err(JsError::new("the list is another size than the engine's targets"));
        }
        let before = gpu.submits;
        let stats = exec::run(&mut *gpu, &list).map_err(|e| JsError::new(&e))?;
        Ok(GpuFrame {
            ops: stats.ops,
            flushes: stats.flushes,
            apart: stats.apart,
            glass: stats.glass,
            submits: gpu.submits - before,
        })
    }

    /// Resolves when the GPU has done all it was given.
    pub fn finish(&self) -> js_sys::Promise {
        let gpu = self.gpu.clone();
        wasm_bindgen_futures::future_to_promise(async move {
            let g = gpu.borrow();
            gpu::finished(&g).await;
            Ok(JsValue::UNDEFINED)
        })
    }

    /// Resolves to the page's pixels, unpremultiplied RGBA8.
    pub fn pixels(&self) -> js_sys::Promise {
        let gpu = self.gpu.clone();
        wasm_bindgen_futures::future_to_promise(async move {
            let g = gpu.borrow();
            let px = gpu::read_back(&g).await.map_err(|e| JsValue::from_str(&e))?;
            Ok(js_sys::Uint8Array::from(unpremultiply(px).as_slice()).into())
        })
    }
}
