cmake_minimum_required(VERSION 3.16)
project(opencc_selection_engine LANGUAGES CXX)
set(CMAKE_CXX_STANDARD 17)
set(CMAKE_CXX_STANDARD_REQUIRED ON)
set(BUILD_SHARED_LIBS OFF CACHE BOOL "" FORCE)
set(BUILD_TESTING OFF CACHE BOOL "" FORCE)
set(ENABLE_GTEST OFF CACHE BOOL "" FORCE)
set(ENABLE_BENCHMARK OFF CACHE BOOL "" FORCE)
set(BUILD_OPENCC_JIEBA_PLUGIN OFF CACHE BOOL "" FORCE)
set(OPENCC_ENABLE_INSTALL OFF CACHE BOOL "" FORCE)
add_compile_options(-fexceptions)
# An exported source tree sits below this plugin repository; do not let
# OpenCC's version probe walk upward and misidentify the parent Git commit.
set(CMAKE_DISABLE_FIND_PACKAGE_Git TRUE)
add_subdirectory("${OPENCC_SOURCE_DIR}" opencc EXCLUDE_FROM_ALL)
add_executable(opencc_selection_engine bridge.cpp trace.cpp)
target_include_directories(opencc_selection_engine PRIVATE
  "${CMAKE_CURRENT_BINARY_DIR}/opencc/src"
  "${OPENCC_SOURCE_DIR}/deps/rapidjson-1.1.0")
target_link_libraries(opencc_selection_engine PRIVATE OpenCC::OpenCC)
set_target_properties(opencc_selection_engine PROPERTIES
  OUTPUT_NAME opencc SUFFIX .mjs
  RUNTIME_OUTPUT_DIRECTORY "${CMAKE_CURRENT_SOURCE_DIR}/generated")
target_link_options(opencc_selection_engine PRIVATE
  --no-entry -fexceptions
  "-sDISABLE_EXCEPTION_CATCHING=0"
  "-sMODULARIZE=1" "-sEXPORT_ES6=1" "-sEXPORT_NAME=createOpenCC"
  "-sENVIRONMENT=worker" "-sFORCE_FILESYSTEM=1"
  "-sALLOW_MEMORY_GROWTH=1" "-sINITIAL_MEMORY=33554432"
  "-sMAXIMUM_MEMORY=268435456" "-sSTACK_SIZE=5242880"
  "-sEXPORTED_FUNCTIONS=['_malloc','_free','_occ_open','_occ_convert','_occ_trace','_occ_check_lengths','_occ_result_ptr','_occ_result_len','_occ_error_ptr','_occ_error_len','_occ_close','_occ_handle_count']"
  "-sEXPORTED_RUNTIME_METHODS=['FS','HEAPU8']")
