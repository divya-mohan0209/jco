//! This file has been auto-generated, please do not modify manually
//! To regenerate this file re-run `cargo xtask generate tests` from the project root

use std::fs;
use tempdir::TempDir;
use xshell::{cmd, Shell};

#[test]
fn cli_file_dir_sync() -> anyhow::Result<()> {
    let sh = Shell::new()?;
    let file_name = "cli_file_dir_sync";
    let tempdir = TempDir::new("{file_name}")?;
    let wasi_file = test_utils::compile(&sh, &tempdir, &file_name)?;
    let _ = fs::remove_dir_all("./tests/rundir/cli_file_dir_sync");
    cmd!(sh, "./src/jco.js run  --jco-dir ./tests/rundir/cli_file_dir_sync --jco-import ./tests/virtualenvs/base.js {wasi_file} hello this '' 'is an argument' 'with 🚩 emoji'").run()?;
    Ok(())
}
