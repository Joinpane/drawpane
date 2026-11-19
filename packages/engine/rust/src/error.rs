//! Every failure the engine reports. Nothing panics across the boundary: decoding, limits,
//! unsupported features and backend failures all come back as an `EngineError` with a code the
//! TypeScript side switches on (`packages/engine/src/index.ts`, `ErrorCode`).

use core::fmt;

/// Stable numbers: TypeScript mirrors them. Add, never renumber.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
#[repr(u32)]
pub enum ErrorCode {
    /// The bytes aren't a display list, or a command in it is malformed.
    Malformed = 1,
    /// A display list of a version this engine doesn't read.
    Version = 2,
    /// A patch made for another revision than the engine holds: send a fresh list.
    Revision = 3,
    /// Something exceeds a limit (records, path size, image size, memory budget).
    Limit = 4,
    /// A record needs a feature this engine doesn't draw yet: the caller draws the page another way.
    Unsupported = 5,
    /// A patch names a record, glyph or image the engine doesn't hold.
    Unknown = 6,
    /// The GPU reported an error.
    Gpu = 7,
    /// The GPU device was lost.
    DeviceLost = 8,
    /// No WebGPU adapter or device.
    NoAdapter = 9,
    /// Bad image data.
    Image = 10,
    /// A call made in the wrong state (rendering on a backend that isn't attached).
    State = 11,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct EngineError {
    pub code: ErrorCode,
    pub message: String,
}

impl EngineError {
    pub fn new(code: ErrorCode, message: impl Into<String>) -> Self {
        Self {
            code,
            message: message.into(),
        }
    }
    pub fn malformed(message: impl Into<String>) -> Self {
        Self::new(ErrorCode::Malformed, message)
    }
    pub fn limit(message: impl Into<String>) -> Self {
        Self::new(ErrorCode::Limit, message)
    }
    pub fn unsupported(message: impl Into<String>) -> Self {
        Self::new(ErrorCode::Unsupported, message)
    }
    pub fn unknown(message: impl Into<String>) -> Self {
        Self::new(ErrorCode::Unknown, message)
    }
}

impl fmt::Display for EngineError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(f, "{:?}: {}", self.code, self.message)
    }
}

pub type Result<T> = core::result::Result<T, EngineError>;
