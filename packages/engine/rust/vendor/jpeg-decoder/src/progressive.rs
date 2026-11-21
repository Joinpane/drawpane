//! Drawpane: compact the coefficients that survive a scaled IDCT.
use crate::parser::Component;
use core::mem::size_of;

pub(crate) struct Plane {
    kept: Vec<i16>,
    significant: Vec<u64>,
    side: usize,
}

impl Plane {
    fn blocks(component: &Component) -> usize {
        usize::from(component.block_size.width) * usize::from(component.block_size.height)
    }

    pub(crate) fn bytes(component: &Component) -> usize {
        let side = component.dct_scale;
        let mask = if side < 8 { size_of::<u64>() } else { 0 };
        Self::blocks(component) * (side * side * size_of::<i16>() + mask)
    }

    pub(crate) fn new(component: &Component) -> Self {
        let blocks = Self::blocks(component);
        let side = component.dct_scale;
        Self {
            kept: vec![0; blocks * side * side],
            significant: if side < 8 { vec![0; blocks] } else { Vec::new() },
            side,
        }
    }

    pub(crate) fn block(&mut self, index: usize) -> Block<'_> {
        let count = self.side * self.side;
        let kept = &mut self.kept[index * count..][..count];
        if self.side == 8 {
            Block::Full(kept.try_into().unwrap())
        } else {
            Block::Reduced {
                kept,
                significant: &mut self.significant[index],
                side: self.side,
            }
        }
    }

    /// The existing IDCT worker reads natural-order 8 by 8 blocks. Expand only
    /// the MCU row it is about to draw. Omitted values are never read by its IDCT.
    pub(crate) fn row(&self, start: usize, blocks: usize) -> Vec<i16> {
        let count = self.side * self.side;
        let row = &self.kept[start * count..][..blocks * count];
        if self.side == 8 {
            return row.to_vec();
        }
        let mut expanded = vec![0; blocks * 64];
        for (block, expanded) in row.chunks_exact(count).zip(expanded.chunks_exact_mut(64)) {
            for (kept, expanded) in block.chunks_exact(self.side).zip(expanded.chunks_exact_mut(8)) {
                expanded[..self.side].copy_from_slice(kept);
            }
        }
        expanded
    }
}

pub(crate) enum Block<'a> {
    Full(&'a mut [i16; 64]),
    Reduced {
        kept: &'a mut [i16],
        significant: &'a mut u64,
        side: usize,
    },
}

impl Block<'_> {
    pub(crate) fn get(&self, index: usize) -> i16 {
        match self {
            Self::Full(values) => values[index],
            Self::Reduced {
                kept,
                significant,
                side,
            } => {
                let (x, y) = (index % 8, index / 8);
                if x < *side && y < *side {
                    kept[y * *side + x]
                } else {
                    // Successive approximation consumes one refinement bit
                    // for each nonzero coefficient. Its sign and magnitude
                    // have no effect on the bitstream or on the scaled IDCT.
                    i16::from(**significant & (1 << index) != 0)
                }
            }
        }
    }

    pub(crate) fn set(&mut self, index: usize, value: i16) {
        match self {
            Self::Full(values) => values[index] = value,
            Self::Reduced {
                kept,
                significant,
                side,
            } => {
                let (x, y) = (index % 8, index / 8);
                if x < *side && y < *side {
                    kept[y * *side + x] = value;
                } else {
                    let bit = 1 << index;
                    **significant &= !bit;
                    if value != 0 {
                        **significant |= bit;
                    }
                }
            }
        }
    }
}
