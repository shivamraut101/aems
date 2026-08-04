use std::io::Cursor;

use image::codecs::webp::WebPEncoder;
use image::{ImageEncoder, ImageError};
use xcap::Monitor;

#[derive(Debug, thiserror::Error)]
pub enum ScreenshotError {
    #[error("no monitor available to capture")]
    NoMonitor,
    #[error("capture failed: {0}")]
    Capture(String),
    #[error("encode failed: {0}")]
    Encode(#[from] ImageError),
}

/// Captures the primary monitor and encodes it as WebP.
///
/// WebP rather than PNG because these upload from employee laptops on whatever
/// connection they have, and a workday of PNG captures is an unreasonable amount of
/// someone's bandwidth.
pub fn capture_primary() -> Result<Vec<u8>, ScreenshotError> {
    let monitors = Monitor::all().map_err(|e| ScreenshotError::Capture(e.to_string()))?;

    let monitor = monitors
        .into_iter()
        .find(|m| m.is_primary().unwrap_or(false))
        .ok_or(ScreenshotError::NoMonitor)?;

    let image = monitor
        .capture_image()
        .map_err(|e| ScreenshotError::Capture(e.to_string()))?;

    let mut buffer = Vec::new();
    WebPEncoder::new_lossless(Cursor::new(&mut buffer)).write_image(
        image.as_raw(),
        image.width(),
        image.height(),
        image::ExtendedColorType::Rgba8,
    )?;

    Ok(buffer)
}
