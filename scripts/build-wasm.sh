#!/usr/bin/env bash
# Builds the Rust kernels to WebAssembly and copies the module into @rigforge/core.
# Requires: rustup target add wasm32-unknown-unknown
set -euo pipefail
cd "$(dirname "$0")/.."
cargo build --manifest-path crates/kernels/Cargo.toml --release --target wasm32-unknown-unknown
mkdir -p packages/core/wasm
cp crates/kernels/target/wasm32-unknown-unknown/release/rigforge_kernels.wasm packages/core/wasm/rigforge_kernels.wasm
ls -l packages/core/wasm/rigforge_kernels.wasm
