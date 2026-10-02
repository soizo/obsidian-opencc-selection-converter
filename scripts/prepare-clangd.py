"""Expose em++'s implicit target/sysroot to clangd, without changing builds."""
import json
import shlex
import subprocess
from pathlib import Path

root = Path(__file__).resolve().parent.parent
try:
    entries = json.loads((root / "build/wasm/compile_commands.json").read_text())
except (OSError, ValueError) as error:
    raise SystemExit("Missing or invalid compile database; run npm run build:engine first") from error
compiler = Path(shlex.split(entries[0]["command"])[0])
arguments = iter(shlex.split(subprocess.check_output([str(compiler), "--cflags"], text=True)))
flags = []
for argument in arguments:
    if argument == "-mllvm":
        next(arguments)  # Backend-only options are not needed by clangd.
    else:
        flags.append(argument)
for entry in entries:
    command = shlex.split(entry.pop("command"))
    entry["arguments"] = [str(compiler.parent.parent / "bin/clang++"), *flags, *command[1:]]
directory = root / "build/clangd"
directory.mkdir(parents=True, exist_ok=True)
(directory / "compile_commands.json").write_text(json.dumps(entries, indent=2) + "\n")
