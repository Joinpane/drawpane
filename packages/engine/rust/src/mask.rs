//! Coverage of premultiplied RGBA8 picture masks (decisions 0016 and 0040).

use crate::record::{MASK_LUMINANCE, MASK_OUTLINE_PICTURE};

/// Paired with `picture_coverage` in `blend.wgsl`. Apply the result while compositing
/// the isolated content so the masked premultiplied channels only round once.
pub(crate) fn coverage(pixel: &[u8], kind: u32) -> f32 {
    match kind {
        MASK_OUTLINE_PICTURE => f32::from(u8::from(pixel[3] != 0)),
        MASK_LUMINANCE => {
            // Figma applies opacity to the luminance of the premultiplied picture.
            let luminance =
                (0.2126 * f32::from(pixel[0]) + 0.7152 * f32::from(pixel[1]) + 0.0722 * f32::from(pixel[2])) / 255.0;
            luminance * (f32::from(pixel[3]) / 255.0)
        }
        _ => f32::from(pixel[3]) / 255.0,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::record::MASK_ALPHA;

    #[test]
    fn translucent_picture_mask_rounds_once_when_composited() {
        let src = [232, 89, 12, 255, 43, 79, 214, 255];
        let mut dst = [244, 243, 239, 255, 244, 243, 239, 255];
        let picture = [0, 0, 0, 77, 0, 0, 0, 77];
        crate::blend::composite_cpu(
            &src,
            &mut dst,
            (2, 1),
            (2, 1),
            (0, 0),
            0,
            1.0,
            None,
            Some((&picture, MASK_ALPHA)),
        );
        assert_eq!(dst, [240, 196, 170, 255, 183, 193, 231, 255]);
    }

    #[test]
    fn luminance_uses_rec709_premultiplied_weights_and_opacity() {
        assert_eq!(coverage(&[255, 255, 255, 255], MASK_LUMINANCE), 1.0);
        assert_eq!(coverage(&[0, 0, 0, 255], MASK_LUMINANCE), 0.0);
        assert_eq!(coverage(&[0, 255, 0, 255], MASK_LUMINANCE), 0.7152);
        assert_eq!(
            coverage(&[128, 128, 128, 128], MASK_LUMINANCE),
            (128.0f32 / 255.0).powi(2)
        );
    }

    #[test]
    fn outline_picture_uses_binary_alpha() {
        assert_eq!(coverage(&[0, 0, 0, 1], MASK_OUTLINE_PICTURE), 1.0);
        assert_eq!(coverage(&[0, 0, 0, 0], MASK_OUTLINE_PICTURE), 0.0);
    }
}
