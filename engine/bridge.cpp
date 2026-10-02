#include <cstdint>
#include <limits>
#include <stdexcept>
#include <string>
#include <string_view>
#include <emscripten/heap.h>
#include <rapidjson/document.h>
#include <rapidjson/memorystream.h>
#include "Config.hpp"
#include "Converter.hpp"
#include "Exception.hpp"

namespace {
constexpr size_t CONFIG_LIMIT = 2 * 1024 * 1024;
constexpr size_t OUTPUT_LIMIT = 8 * 1024 * 1024;
constexpr size_t INPUT_SCALARS = 200000;
opencc::ConverterPtr converter;
uint32_t currentHandle = 0;
uint32_t lastHandle = 0;
std::string result;
std::string error;

std::string_view input(uint32_t ptr, uint32_t len) {
  const size_t heap = emscripten_get_heap_size();
  if ((len && !ptr) || ptr > heap || len > heap - ptr) {
    throw std::runtime_error("INVALID_TEXT: Invalid input memory range");
  }
  return len ? std::string_view(reinterpret_cast<const char*>(ptr), len) : std::string_view();
}

void validateUtf8(std::string_view text, size_t maxScalars = std::numeric_limits<size_t>::max()) {
  if (text.empty()) return;
  rapidjson::MemoryStream stream(text.data(), text.size());
  size_t count = 0;
  while (stream.Tell() < text.size()) {
    unsigned scalar = 0;
    if (!rapidjson::UTF8<>::Decode(stream, &scalar) || scalar == 0) {
      throw std::runtime_error("INVALID_TEXT: Invalid UTF-8 or NUL is not supported");
    }
    if (++count > maxScalars) throw std::runtime_error("INPUT_LIMIT: Selection exceeds the Unicode scalar limit");
  }
}

void validateJson(const rapidjson::Value& value, unsigned depth = 0) {
  if (depth > 32) throw std::runtime_error("CONFIG_LIMIT: Configuration nesting exceeds the limit");
  if (value.IsString()) validateUtf8({value.GetString(), value.GetStringLength()});
  if (value.IsArray()) {
    for (const auto& item : value.GetArray()) validateJson(item, depth + 1);
  } else if (value.IsObject()) {
    for (auto it = value.MemberBegin(); it != value.MemberEnd(); ++it) {
      validateUtf8({it->name.GetString(), it->name.GetStringLength()});
      validateJson(it->value, depth + 1);
    }
  }
}

void resetResult() { result.clear(); error.clear(); }
} // namespace

extern "C" {
int32_t occ_open(uint32_t ptr, uint32_t len) {
  resetResult();
  converter.reset();
  currentHandle = 0;
  try {
    if (len > CONFIG_LIMIT) throw std::runtime_error("CONFIG_LIMIT: Configuration exceeds the byte limit");
    const auto json = input(ptr, len);
    validateUtf8(json);
    rapidjson::Document document;
    document.Parse<rapidjson::kParseCommentsFlag | rapidjson::kParseTrailingCommasFlag |
                   rapidjson::kParseValidateEncodingFlag | rapidjson::kParseIterativeFlag>(json.data(), json.size());
    if (document.HasParseError() || !document.IsObject()) throw std::runtime_error("INVALID_CONFIG: Invalid OpenCC JSON");
    validateJson(document);
    const auto segmentation = document.FindMember("segmentation");
    if (segmentation != document.MemberEnd()) {
      const auto& value = segmentation->value;
      if (!value.IsObject() || !value.HasMember("type") || !value["type"].IsString() ||
          std::string_view(value["type"].GetString(), value["type"].GetStringLength()) != "mmseg") {
        throw std::runtime_error("UNSUPPORTED_SEGMENTATION: Only mmseg segmentation is supported");
      }
    }
    opencc::Config config;
    converter = config.NewFromString(std::string(json), std::string("/snapshot"));
    if (!converter) throw std::runtime_error("ENGINE_ERROR: OpenCC did not create a converter");
    lastHandle = lastHandle % static_cast<uint32_t>(std::numeric_limits<int32_t>::max()) + 1;
    currentHandle = lastHandle;
    return static_cast<int32_t>(currentHandle);
  } catch (const opencc::Exception& exception) {
    error = std::string("ENGINE_ERROR: ") + exception.what();
  } catch (const std::exception& exception) {
    error = exception.what();
  } catch (...) {
    error = "ENGINE_ERROR: Unknown configuration loading failure";
  }
  converter.reset();
  return -1;
}

int32_t occ_convert(uint32_t handle, uint32_t ptr, uint32_t len) {
  resetResult();
  try {
    if (!converter || handle != currentHandle) throw std::runtime_error("ENGINE_ERROR: Invalid converter handle");
    const auto text = input(ptr, len);
    validateUtf8(text, INPUT_SCALARS);
    result = converter->Convert(text);
    // Task 3 adds generation-time budgets to the shared native matching loop.
    if (result.size() > OUTPUT_LIMIT) throw std::runtime_error("OUTPUT_LIMIT: Converted output exceeds the byte limit");
    validateUtf8(result);
    return 0;
  } catch (const opencc::Exception&) {
    // Never echo selected text through a native exception message.
    error = "ENGINE_ERROR: OpenCC conversion failed";
  } catch (const std::exception& exception) {
    error = exception.what();
  } catch (...) {
    error = "ENGINE_ERROR: Unknown conversion failure";
  }
  result.clear();
  return -1;
}

uint32_t occ_result_ptr() { return reinterpret_cast<uintptr_t>(result.data()); }
uint32_t occ_result_len() { return static_cast<uint32_t>(result.size()); }
uint32_t occ_error_ptr() { return reinterpret_cast<uintptr_t>(error.data()); }
uint32_t occ_error_len() { return static_cast<uint32_t>(error.size()); }
uint32_t occ_handle_count() { return converter ? 1 : 0; }
void occ_close(uint32_t handle) {
  if (handle == currentHandle) {
    converter.reset();
    currentHandle = 0;
    result.clear();
    error.clear();
  }
}
} // extern "C"
