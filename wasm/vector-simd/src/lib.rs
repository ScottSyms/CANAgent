//! Batch dot-product kernel for CANChat Agent's on-device vector search.
//!
//! Mirrors the JS hot loop in `src/shared/vectorSearch.ts::scoreVectors`
//! exactly: for each of `chunk_count` rows of `dim` int8 values, compute the
//! dot product against a shared f32 weight vector. Compiled with
//! `target-feature=+simd128` (see `.cargo/config.toml`) so LLVM auto-vectorizes
//! this loop — deliberately not hand-rolled `std::arch::wasm32` intrinsics;
//! this is the "ship the simple version, measure, then reach for the bigger
//! hammer only if needed" version.

use wasm_bindgen::prelude::*;

/// `vectors` is `chunk_count * dim` int8 values, row `i` at
/// `[i*dim, (i+1)*dim)`. `qw` is the query weight vector (length `dim`,
/// already query-constant-folded on the JS side). Returns one f32 score per
/// row, in row order.
#[wasm_bindgen]
pub fn dot_product_batch(vectors: &[i8], qw: &[f32], dim: usize, chunk_count: usize) -> Vec<f32> {
    let mut out = vec![0f32; chunk_count];
    for i in 0..chunk_count {
        let base = i * dim;
        let row = &vectors[base..base + dim];
        let mut score = 0f32;
        for d in 0..dim {
            score += row[d] as f32 * qw[d];
        }
        out[i] = score;
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    // Tiny dependency-free xorshift PRNG so tests don't need the `rand` crate.
    struct Xorshift(u64);
    impl Xorshift {
        fn next_u64(&mut self) -> u64 {
            let mut x = self.0;
            x ^= x << 13;
            x ^= x >> 7;
            x ^= x << 17;
            self.0 = x;
            x
        }
        fn next_i8(&mut self) -> i8 {
            (self.next_u64() % 256) as i8
        }
        fn next_f32(&mut self) -> f32 {
            ((self.next_u64() % 2001) as f32 - 1000.0) / 1000.0
        }
    }

    #[test]
    fn known_small_case() {
        // 2 rows x 3 dims.
        let vectors: [i8; 6] = [1, 2, 3, -1, -2, -3];
        let qw: [f32; 3] = [1.0, 0.5, 2.0];
        let out = dot_product_batch(&vectors, &qw, 3, 2);
        assert_eq!(out, vec![1.0 * 1.0 + 2.0 * 0.5 + 3.0 * 2.0, -1.0 - 1.0 - 6.0]);
    }

    #[test]
    fn zero_chunks_is_empty() {
        let out = dot_product_batch(&[], &[1.0, 2.0], 2, 0);
        assert!(out.is_empty());
    }

    /// Randomized cross-check: the kernel's f32-accumulated result must match
    /// an independently-computed f64 reference within a tight tolerance, for
    /// many random (chunk_count, dim) shapes. Catches accumulation-order bugs
    /// if this function is ever rewritten with explicit SIMD intrinsics.
    #[test]
    fn matches_f64_reference_for_random_inputs() {
        let mut rng = Xorshift(0x2545F4914F6CDD1D);
        for trial in 0..200 {
            let dim = 1 + (rng.next_u64() % 400) as usize;
            let chunk_count = (rng.next_u64() % 300) as usize;
            let vectors: Vec<i8> = (0..dim * chunk_count).map(|_| rng.next_i8()).collect();
            let qw: Vec<f32> = (0..dim).map(|_| rng.next_f32()).collect();

            let out = dot_product_batch(&vectors, &qw, dim, chunk_count);
            assert_eq!(out.len(), chunk_count, "trial {trial}");

            for i in 0..chunk_count {
                let base = i * dim;
                let expected: f64 = (0..dim)
                    .map(|d| vectors[base + d] as f64 * qw[d] as f64)
                    .sum();
                let diff = (out[i] as f64 - expected).abs();
                let tol = 1e-3 * expected.abs().max(1.0);
                assert!(
                    diff <= tol,
                    "trial {trial} row {i}: got {} expected {expected} (dim={dim})",
                    out[i]
                );
            }
        }
    }
}
