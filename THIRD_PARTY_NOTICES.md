# Third-party notices

The plugin's offline WebAssembly engine is built from the following fixed upstream sources. Exact commits and toolchain versions are recorded in `engine/upstream.lock.json`.

## Open Chinese Convert (OpenCC)

Copyright Carbo Kuo and OpenCC contributors; individual notices are retained in the pinned source.

Source: <https://github.com/BYVoid/OpenCC>

License: Apache License 2.0; complete text in `engine/licenses/opencc.txt`, copied from the pinned source.

The project adds a C ABI bridge and tracing/enumeration code in `engine/bridge.cpp` and `engine/trace.cpp`. The build applies `engine/patches/opencc-trace.patch` to an exported source copy: it adds an optional observer and a pre-append output budget to `Conversion.hpp` / `Conversion.cpp`, while retaining OpenCC's matching implementation. Both modified source files carry an explicit modification notice. The external upstream checkout is never modified.

## marisa-trie

Copyright 2010–2025 Susumu Yata.

Source bundled by OpenCC under `deps/marisa-0.3.1`

License option used: BSD 2-Clause. The complete upstream dual-license notice is retained in `engine/licenses/marisa.md`.

## Darts-clone

Copyright 2008–2014 Susumu Yata.

Source bundled by OpenCC under `deps/darts-clone-0.32h`

License: BSD 2-Clause; complete text in `engine/licenses/darts-clone.md`.

## RapidJSON

Copyright 2015 THL A29 Limited, a Tencent company, and Milo Yip.

Source bundled by OpenCC under `deps/rapidjson-1.1.0`

License: MIT. OpenCC's vendored headers carry MIT notices but omit the standalone license file. `engine/licenses/rapidjson.txt` is therefore copied from the author's official `Tencent/rapidjson` tag `v1.1.0`, not from an independent mirror. It also records upstream optional components; its JSON License applies to `bin/jsonchecker/`, which is not part of this engine. The vendored `rapidjson/uri.h` additionally carries Copyright IBM Corporation 2021 under MIT. RapidJSON is used by OpenCC and the bridge's JSON preflight.

## Emscripten

Source: <https://github.com/emscripten-core/emsdk>

License: MIT or University of Illinois/NCSA; the complete upstream notice (including its Node-derived path utility attribution) is in `engine/licenses/emscripten.txt`. Generated loader glue is embedded in the plugin; the compiler/SDK is not downloaded or executed at runtime.

WASM standard-library license texts are copied from the installed fixed Emscripten release into `engine/licenses/musl.txt`, `libcxx.txt`, `libcxxabi.txt`, `libunwind.txt`, `compiler-rt.txt`, and `llvm-libc.txt`. These cover the corresponding bundled runtime sources, rather than asserting that the entire SDK is distributed.

The build embeds this notice and the complete texts under `engine/licenses/` as line comments in `main.js`, so the single installed asset carries its licenses. The source repository retains the original license files as well.
