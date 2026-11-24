//! The `ResourceMetadata` type.

use alloc::vec::Vec;

use bit_vec::BitVec;
use wgt::strict_assert;

/// A set of resources, holding a `Arc<T>` and epoch for each member.
///
/// Testing for membership is fast, and iterating over members is
/// reasonably fast in practice. Storage consumption is proportional
/// to the largest id index of any member, not to the number of
/// members, but a bit vector tracks occupancy, so iteration touches
/// only occupied elements.
#[derive(Debug)]
pub(super) struct ResourceMetadata<T: Clone> {
    /// If the resource with index `i` is a member, `owned[i]` is `true`.
    owned: BitVec<usize>,

    /// A vector holding clones of members' `T`s.
    resources: Vec<Option<T>>,

    // Drawpane: sparse index list for O(touched) `clear_sparse_with`, `is_empty`, and
    // `owned_indices` on pooled `UsageScope`s instead of O(live resources) zeroing per pass.
    dirty: Vec<usize>,
    /// True when `dirty` holds the exact set of owned indices without duplicates or removals.
    dirty_exact: bool,
}

impl<T: Clone> ResourceMetadata<T> {
    pub(super) fn new() -> Self {
        Self {
            owned: BitVec::default(),
            resources: Vec::new(),
            dirty: Vec::new(),
            dirty_exact: true,
        }
    }

    pub(super) fn set_size(&mut self, size: usize) {
        if size < self.resources.len() {
            self.dirty.retain(|&index| index < size);
        }
        self.resources.resize(size, None);
        resize_bitvec(&mut self.owned, size);
    }

    #[allow(dead_code)]
    pub(super) fn clear(&mut self) {
        self.resources.clear();
        self.owned.fill(false);
        self.dirty.clear();
        self.dirty_exact = true;
    }

    // Drawpane: clear only touched indices while keeping `resources` and `owned` at their
    // current length so pooled `UsageScope`s avoid O(live resources) clear + resize every pass.
    pub(super) fn clear_sparse_with(&mut self, mut on_clear: impl FnMut(usize)) {
        for index in self.dirty.drain(..) {
            if index < self.resources.len() {
                unsafe { *self.resources.get_unchecked_mut(index) = None };
                self.owned.set(index, false);
                on_clear(index);
            }
        }
        self.dirty_exact = true;
        #[cfg(debug_assertions)]
        {
            debug_assert!(
                !self.owned.any(),
                "ResourceMetadata::clear_sparse_with missed an owned bit"
            );
            debug_assert!(
                self.resources.iter().all(Option::is_none),
                "ResourceMetadata::clear_sparse_with missed a resource slot"
            );
        }
    }

    /// Ensures a given index is in bounds for all arrays and does
    /// sanity checks of the presence of a refcount.
    ///
    /// In release mode this function is completely empty and is removed.
    pub(super) fn tracker_assert_in_bounds(&self, index: usize) {
        strict_assert!(index < self.owned.len());
        strict_assert!(index < self.resources.len());
        strict_assert!(if self.contains(index) {
            self.resources[index].is_some()
        } else {
            true
        });
    }

    /// Returns true if the tracker owns no resources.
    pub(super) fn is_empty(&self) -> bool {
        if self.dirty_exact {
            self.dirty.is_empty()
        } else {
            !self.owned.any()
        }
    }

    /// Returns true if the set contains the resource with the given index.
    pub(super) fn contains(&self, index: usize) -> bool {
        self.owned.get(index).unwrap_or(false)
    }

    /// Returns true if the set contains the resource with the given index.
    ///
    /// # Safety
    ///
    /// The given `index` must be in bounds for this `ResourceMetadata`'s
    /// existing tables. See `tracker_assert_in_bounds`.
    #[inline(always)]
    pub(super) unsafe fn contains_unchecked(&self, index: usize) -> bool {
        unsafe { self.owned.get(index).unwrap_unchecked() }
    }

    /// Insert a resource into the set.
    ///
    /// Add the resource with the given index, epoch, and reference count to the
    /// set.
    ///
    /// Returns a reference to the newly inserted resource.
    /// (This allows avoiding a clone/reference count increase in many cases.)
    ///
    /// # Safety
    ///
    /// The given `index` must be in bounds for this `ResourceMetadata`'s
    /// existing tables. See `tracker_assert_in_bounds`.
    #[inline(always)]
    pub(super) unsafe fn insert(&mut self, index: usize, resource: T) -> &T {
        let was_owned = unsafe { self.owned.get(index).unwrap_unchecked() };
        if !was_owned {
            self.owned.set(index, true);
            self.dirty.push(index);
        }
        let resource_dst = unsafe { self.resources.get_unchecked_mut(index) };
        resource_dst.insert(resource)
    }

    /// Get the resource with the given index.
    ///
    /// # Safety
    ///
    /// The given `index` must be in bounds for this `ResourceMetadata`'s
    /// existing tables. See `tracker_assert_in_bounds`.
    #[inline(always)]
    pub(super) unsafe fn get_resource_unchecked(&self, index: usize) -> &T {
        unsafe {
            self.resources
                .get_unchecked(index)
                .as_ref()
                .unwrap_unchecked()
        }
    }

    /// Returns an iterator over the resources owned by `self`.
    pub(super) fn owned_resources(&self) -> impl Iterator<Item = &T> + '_ {
        self.owned_indices().map(move |index| {
            let resource = unsafe { self.resources.get_unchecked(index) };
            resource.as_ref().unwrap()
        })
    }

    /// Returns an iterator over the indices of all resources owned by `self`.
    pub(super) fn owned_indices(&self) -> impl Iterator<Item = usize> + '_ {
        if !self.owned.is_empty() {
            self.tracker_assert_in_bounds(self.owned.len() - 1)
        };
        if self.dirty_exact {
            #[cfg(debug_assertions)]
            debug_assert_eq!(
                self.dirty.len(),
                self.owned.iter().filter(|bit| *bit).count(),
                "ResourceMetadata sparse dirty list diverged from owned bitvec"
            );
            OwnedIndices::Sparse(self.dirty.iter())
        } else {
            OwnedIndices::Dense(BitVecIndices::new(&self.owned))
        }
    }

    /// Remove the resource with the given index from the set.
    pub(super) unsafe fn remove(&mut self, index: usize) {
        unsafe {
            *self.resources.get_unchecked_mut(index) = None;
        }
        self.owned.set(index, false);
        self.dirty_exact = false;
    }
}

/// A source of resource metadata.
///
/// This is used to abstract over the various places
/// trackers can get new resource metadata from.
pub(super) enum ResourceMetadataProvider<'a, T: Clone> {
    /// Comes directly from explicit values.
    Direct { resource: &'a T },
    /// Comes from another metadata tracker.
    Indirect { metadata: &'a ResourceMetadata<T> },
}
impl<T: Clone> ResourceMetadataProvider<'_, T> {
    /// Get a reference to the resource from this.
    ///
    /// # Safety
    ///
    /// - The index must be in bounds of the metadata tracker if this uses an indirect source.
    #[inline(always)]
    pub(super) unsafe fn get(&self, index: usize) -> &T {
        match self {
            ResourceMetadataProvider::Direct { resource } => resource,
            ResourceMetadataProvider::Indirect { metadata } => {
                metadata.tracker_assert_in_bounds(index);
                {
                    let resource = unsafe { metadata.resources.get_unchecked(index) }.as_ref();
                    unsafe { resource.unwrap_unchecked() }
                }
            }
        }
    }
}

/// Resizes the given bitvec to the given size. I'm not sure why this is hard to do but it is.
fn resize_bitvec<B: bit_vec::BitBlock>(vec: &mut BitVec<B>, size: usize) {
    let owned_size_to_grow = size.checked_sub(vec.len());
    if let Some(delta) = owned_size_to_grow {
        if delta != 0 {
            vec.grow(delta, false);
        }
    } else {
        vec.truncate(size);
    }
}

// Drawpane: sparse-or-dense iterator over owned indices.
enum OwnedIndices<'a> {
    Sparse(core::slice::Iter<'a, usize>),
    Dense(BitVecIndices<'a>),
}

impl Iterator for OwnedIndices<'_> {
    type Item = usize;

    #[inline]
    fn next(&mut self) -> Option<usize> {
        match self {
            Self::Sparse(iter) => iter.next().copied(),
            Self::Dense(iter) => iter.next(),
        }
    }
}

struct BitVecIndices<'a> {
    blocks: bit_vec::Blocks<'a, usize>,
    current_word: usize,
    current_base: usize,
    next_base: usize,
    len: usize,
}

impl<'a> BitVecIndices<'a> {
    fn new(ownership: &'a BitVec<usize>) -> Self {
        Self {
            blocks: ownership.blocks(),
            current_word: 0,
            current_base: 0,
            next_base: 0,
            len: ownership.len(),
        }
    }
}

impl Iterator for BitVecIndices<'_> {
    type Item = usize;

    #[inline]
    fn next(&mut self) -> Option<usize> {
        const BITS_PER_BLOCK: usize = usize::BITS as usize;
        loop {
            if self.current_word != 0 {
                let tz = self.current_word.trailing_zeros() as usize;
                self.current_word &= self.current_word - 1;
                let idx = self.current_base + tz;
                return (idx < self.len).then_some(idx);
            }
            self.current_word = self.blocks.next()?;
            self.current_base = self.next_base;
            self.next_base += BITS_PER_BLOCK;
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use alloc::vec;

    #[test]
    fn sparse_clear_preserves_capacity_and_resets_only_touched() {
        let mut meta = ResourceMetadata::<u32>::new();
        meta.set_size(256);
        assert!(meta.is_empty());

        unsafe {
            meta.insert(3, 30);
            meta.insert(129, 1290);
            meta.insert(255, 2550);
            // Re-inserting an owned index must not duplicate it in `dirty`.
            meta.insert(129, 1291);
        }
        assert!(!meta.is_empty());

        let mut indices: Vec<usize> = meta.owned_indices().collect();
        indices.sort_unstable();
        assert_eq!(indices, vec![3, 129, 255]);
        assert_eq!(unsafe { *meta.get_resource_unchecked(129) }, 1291);

        let mut cleared = Vec::new();
        meta.clear_sparse_with(|idx| cleared.push(idx));
        cleared.sort_unstable();
        assert_eq!(cleared, vec![3, 129, 255]);
        assert!(meta.is_empty());
        assert_eq!(meta.resources.len(), 256);
        assert_eq!(meta.owned.len(), 256);
        assert_eq!(meta.owned_indices().count(), 0);
    }

    #[test]
    fn sparse_remove_falls_back_to_dense_and_recovers_on_clear() {
        let mut meta = ResourceMetadata::<u32>::new();
        meta.set_size(130);
        unsafe {
            meta.insert(0, 1);
            meta.insert(63, 2);
            meta.insert(64, 3);
            meta.insert(129, 4);
            meta.remove(63);
            // Re-insert after remove.
            meta.insert(63, 5);
            meta.remove(64);
        }
        assert!(!meta.dirty_exact);
        assert!(!meta.is_empty());

        let dense: Vec<usize> = meta.owned_indices().collect();
        let expected: Vec<usize> = (0..130).filter(|&i| meta.contains(i)).collect();
        assert_eq!(dense, expected);
        assert_eq!(dense, vec![0, 63, 129]);

        let mut cleared = Vec::new();
        meta.clear_sparse_with(|idx| cleared.push(idx));
        assert!(meta.dirty_exact);
        assert!(meta.is_empty());
        assert_eq!(meta.owned_indices().count(), 0);
    }
}
