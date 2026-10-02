#include "trace.hpp"

#include <cstdint>
#include <cstring>
#include <numeric>
#include <stdexcept>
#include <utility>
#include <vector>
#include <rapidjson/document.h>
#include <rapidjson/memorystream.h>
#include <rapidjson/writer.h>
#include "ConfigBasedConverter.hpp"
#include "ConversionChain.hpp" // IWYU pragma: keep — completes the public shared_ptr alias
#include "Conversion.hpp"
#include "Dict.hpp" // IWYU pragma: keep — completes the public shared_ptr alias
#include "Lexicon.hpp" // IWYU pragma: keep — required for iteration through the alias
#include "Segments.hpp" // IWYU pragma: keep — required for iteration through the alias

namespace selection {
namespace {
constexpr size_t TRACE_LIMIT = 64 * 1024 * 1024;

struct JsonSink {
  using Ch = char;
  std::string text;
  void Put(char value) {
    if (text.size() >= TRACE_LIMIT) throw std::runtime_error("TRACE_LIMIT: Serialized report exceeds budget");
    // Avoid libc++ doubling past the report budget before Put can reject it.
    if (text.size() == text.capacity() && text.capacity() > TRACE_LIMIT / 2) text.reserve(TRACE_LIMIT);
    text.push_back(value);
  }
  void Flush() {}
};
using Writer = rapidjson::Writer<JsonSink>;

void String(Writer& writer, std::string_view value) {
  writer.String(value.data(), static_cast<rapidjson::SizeType>(value.size()));
}
void Span(Writer& writer, size_t from, size_t to) {
  writer.StartObject();
  writer.Key("from"); writer.Uint(from);
  writer.Key("to"); writer.Uint(to);
  writer.EndObject();
}
void Budget(size_t bytes) {
  if (bytes > TRACE_LIMIT) throw std::runtime_error("TRACE_LIMIT: Trace working data exceeds budget");
}

rapidjson::Document Parse(std::string_view config) {
  rapidjson::Document doc;
  doc.Parse<rapidjson::kParseCommentsFlag | rapidjson::kParseTrailingCommasFlag |
            rapidjson::kParseValidateEncodingFlag | rapidjson::kParseIterativeFlag>(config.data(), config.size());
  if (doc.HasParseError() || !doc.IsObject()) throw std::runtime_error("INVALID_CONFIG: Invalid trace configuration");
  return doc;
}

// OpenCC omits empty groups. Preserve original JSON indices when pairing its
// native objects with metadata; this is not dictionary matching or flattening.
bool Effective(const rapidjson::Value& dict) {
  if (!dict.IsObject() || !dict.HasMember("type") || !dict["type"].IsString()) {
    throw std::runtime_error("INVALID_CONFIG: Invalid dictionary metadata");
  }
  if (std::string_view(dict["type"].GetString()) != "group") return true;
  if (!dict.HasMember("dicts") || !dict["dicts"].IsArray()) throw std::runtime_error("INVALID_CONFIG: Invalid group metadata");
  for (const auto& child : dict["dicts"].GetArray()) if (Effective(child)) return true;
  return false;
}

struct Stage {
  opencc::ConversionPtr conversion;
  const rapidjson::Value* dict;
  std::string path;
};

std::vector<Stage> Stages(const opencc::ConverterPtr& converter,
                          const rapidjson::Value& configs, const std::string& path) {
  if (!configs.IsArray() || !converter->GetConversionChain()) throw std::runtime_error("INVALID_CONFIG: Unsupported native chain");
  auto conversions = converter->GetConversionChain()->GetConversions();
  auto next = conversions.begin();
  std::vector<Stage> stages;
  for (rapidjson::SizeType index = 0; index < configs.Size(); ++index) {
    const auto& config = configs[index];
    if (!config.IsObject() || !config.HasMember("dict")) throw std::runtime_error("INVALID_CONFIG: Invalid conversion stage");
    if (!Effective(config["dict"])) continue;
    if (next == conversions.end()) throw std::runtime_error("ENGINE_ERROR: Native stage metadata mismatch");
    stages.push_back({*next++, &config["dict"], path + "[" + std::to_string(index) + "]"});
  }
  if (next != conversions.end()) throw std::runtime_error("ENGINE_ERROR: Native stage metadata mismatch");
  return stages;
}

struct Match {
  std::string stagePath;
  std::string dictPath;
  size_t inputFrom, inputTo, outputFrom, outputTo;
  std::string selected;
};
struct Mapped {
  std::string text;
  std::vector<uint32_t> origins;
};
struct Range { size_t from, to; };

Mapped Apply(const opencc::ConverterPtr& converter, const std::vector<Stage>& stages,
             Mapped current, std::vector<Match>& matches, size_t& matchBytes) {
  std::vector<Range> segments;
  auto segmentation = converter->GetSegmentation();
  if (segmentation) {
    auto nativeSegments = segmentation->Segment(current.text);
    size_t cursor = 0;
    for (const char* segment : *nativeSegments) {
      const size_t length = std::strlen(segment);
      if (cursor > current.text.size() || length > current.text.size() - cursor ||
          current.text.compare(cursor, length, segment, length) != 0) {
        throw std::runtime_error("ENGINE_ERROR: Segmentation changed source text");
      }
      segments.push_back({cursor, cursor + length});
      cursor += length;
    }
    if (cursor != current.text.size()) throw std::runtime_error("ENGINE_ERROR: Segmentation lost source text");
  } else segments.push_back({0, current.text.size()});

  for (const auto& stage : stages) {
    Mapped next;
    std::vector<Range> nextSegments;
    size_t inputScalar = 0;
    const std::string dictPath = stage.path + ".dict";
    opencc::Conversion::Observer observer = [&](std::string_view input, std::string_view output, bool matched) {
      const size_t inputCount = CountScalars(input);
      const size_t outputCount = CountScalars(output);
      if (!inputCount || inputScalar > current.origins.size() || inputCount > current.origins.size() - inputScalar) {
        throw std::runtime_error("ENGINE_ERROR: Match source range is invalid");
      }
      const size_t outputFrom = next.origins.size();
      const size_t cost = matched ? sizeof(Match) + stage.path.size() + dictPath.size() + output.size() : 0;
      Budget(matchBytes + cost + (current.origins.size() + outputFrom + outputCount) * sizeof(uint32_t));
      if (matched) {
        matchBytes += cost;
        matches.push_back({stage.path, dictPath, inputScalar, inputScalar + inputCount,
                           outputFrom, outputFrom + outputCount, std::string(output)});
      }
      if (inputCount == outputCount) {
        next.origins.insert(next.origins.end(), current.origins.begin() + inputScalar,
                            current.origins.begin() + inputScalar + inputCount);
      } else {
        next.origins.insert(next.origins.end(), outputCount, current.origins[inputScalar]);
      }
      inputScalar += inputCount;
    };
    for (const auto& segment : segments) {
      const size_t start = next.text.size();
      const std::string_view phrase(current.text.data() + segment.from, segment.to - segment.from);
      // Exact same PrefixMatch/IDS/SkipUnmatchable loop as ordinary conversion.
      stage.conversion->AppendConverted(phrase, &next.text, &observer);
      nextSegments.push_back({start, next.text.size()});
    }
    if (inputScalar != current.origins.size()) throw std::runtime_error("ENGINE_ERROR: Trace did not cover its input");
    current = std::move(next);
    segments = std::move(nextSegments);
  }
  return current;
}

struct Risk {
  std::string stagePath, dictPath, key, value;
  size_t inputLength, outputLength;
};
struct Inspection {
  size_t checked = 0;
  size_t riskBytes = 0;
  bool incomplete = false;
  std::vector<Risk> risks;
  std::vector<std::string> reasons;
};

void Scan(const opencc::DictPtr& dict, const rapidjson::Value& config,
          const std::string& stagePath, const std::string& path, Inspection& report) {
  const auto children = dict->GetDictGroupItems();
  if (children) {
    if (!config.HasMember("dicts") || !config["dicts"].IsArray()) throw std::runtime_error("ENGINE_ERROR: Group metadata mismatch");
    auto next = children->begin();
    const auto& configs = config["dicts"];
    for (rapidjson::SizeType index = 0; index < configs.Size(); ++index) {
      if (!Effective(configs[index])) continue;
      if (next == children->end()) throw std::runtime_error("ENGINE_ERROR: Group metadata mismatch");
      Scan(*next++, configs[index], stagePath, path + ".dicts[" + std::to_string(index) + "]", report);
    }
    if (next != children->end()) throw std::runtime_error("ENGINE_ERROR: Group metadata mismatch");
    return;
  }
  const auto lexicon = dict->GetLexicon();
  if (!lexicon) throw std::runtime_error("ENGINE_ERROR: Dictionary enumeration unavailable");
  for (const auto& entry : *lexicon) {
    const auto key = entry->KeyView();
    const auto value = entry->GetDefaultView();
    const size_t inputCount = CountScalars(key);
    const size_t outputCount = CountScalars(value);
    if (!inputCount) throw std::runtime_error("INVALID_DICT: Empty dictionary key");
    if (inputCount != outputCount) {
      const size_t cost = sizeof(Risk) + stagePath.size() + path.size() + key.size() + value.size();
      Budget(report.riskBytes + cost);
      report.riskBytes += cost;
      report.risks.push_back({stagePath, path, std::string(key), std::string(value), inputCount, outputCount});
    }
    ++report.checked;
  }
}

std::string SerializeInspection(const Inspection& report) {
  JsonSink sink;
  Writer writer(sink);
  writer.StartObject();
  writer.Key("status"); writer.String(report.incomplete ? "incomplete" : report.risks.empty() ? "equal" : "risk");
  writer.Key("checkedEntries"); writer.Uint64(report.checked);
  writer.Key("risks"); writer.StartArray();
  for (const auto& risk : report.risks) {
    writer.StartObject();
    writer.Key("stagePath"); String(writer, risk.stagePath);
    writer.Key("dictPath"); String(writer, risk.dictPath);
    writer.Key("key"); String(writer, risk.key);
    writer.Key("defaultValue"); String(writer, risk.value);
    writer.Key("inputLength"); writer.Uint(risk.inputLength);
    writer.Key("outputLength"); writer.Uint(risk.outputLength);
    writer.EndObject();
  }
  writer.EndArray();
  writer.Key("reasons"); writer.StartArray();
  for (const auto& reason : report.reasons) String(writer, reason);
  writer.EndArray();
  writer.EndObject();
  return std::move(sink.text);
}
} // namespace

size_t CountScalars(std::string_view text, size_t limit) {
  if (text.empty()) return 0;
  rapidjson::MemoryStream stream(text.data(), text.size());
  size_t count = 0;
  while (stream.Tell() < text.size()) {
    unsigned scalar = 0;
    if (!rapidjson::UTF8<>::Decode(stream, &scalar) || scalar == 0) {
      throw std::runtime_error("INVALID_TEXT: Invalid UTF-8 or NUL is not supported");
    }
    if (++count > limit) throw std::runtime_error("INPUT_LIMIT: Selection exceeds the Unicode scalar limit");
  }
  return count;
}

std::string Trace(const opencc::ConverterPtr& converter, std::string_view config, std::string_view input) {
  auto doc = Parse(config);
  const auto normalized = std::dynamic_pointer_cast<opencc::ConfigBasedConverter>(converter);
  Mapped mapped{std::string(input), std::vector<uint32_t>(CountScalars(input, 200000))};
  std::iota(mapped.origins.begin(), mapped.origins.end(), 0);
  std::vector<Match> matches;
  size_t matchBytes = 0;
  if (doc.HasMember("normalization")) {
    if (!normalized) throw std::runtime_error("ENGINE_ERROR: Missing native normalization converter");
    const auto norm = normalized->GetNormalizationConverter();
    mapped = Apply(norm, Stages(norm, doc["normalization"], "$.normalization"), std::move(mapped), matches, matchBytes);
  }
  if (!doc.HasMember("conversion_chain")) throw std::runtime_error("INVALID_CONFIG: Missing conversion chain");
  mapped = Apply(converter, Stages(converter, doc["conversion_chain"], "$.conversion_chain"), std::move(mapped), matches, matchBytes);
  JsonSink sink;
  Writer writer(sink);
  writer.StartObject();
  writer.Key("output"); String(writer, mapped.text);
  writer.Key("origins"); writer.StartArray();
  for (uint32_t origin : mapped.origins) writer.Uint(origin);
  writer.EndArray();
  writer.Key("matches"); writer.StartArray();
  for (const auto& match : matches) {
    writer.StartObject();
    writer.Key("stagePath"); String(writer, match.stagePath);
    writer.Key("dictPath"); String(writer, match.dictPath);
    writer.Key("inputScalar"); Span(writer, match.inputFrom, match.inputTo);
    writer.Key("outputScalar"); Span(writer, match.outputFrom, match.outputTo);
    writer.Key("inputLength"); writer.Uint(match.inputTo - match.inputFrom);
    writer.Key("outputLength"); writer.Uint(match.outputTo - match.outputFrom);
    writer.Key("selected"); String(writer, match.selected);
    writer.EndObject();
  }
  writer.EndArray();
  writer.EndObject();
  return std::move(sink.text);
}

std::string CheckLengths(const opencc::ConverterPtr& converter, std::string_view config) {
  Inspection report;
  try {
    auto doc = Parse(config);
    const auto normalized = std::dynamic_pointer_cast<opencc::ConfigBasedConverter>(converter);
    std::vector<Stage> stages;
    if (doc.HasMember("normalization")) {
      if (!normalized) throw std::runtime_error("ENGINE_ERROR: Missing native normalization converter");
      stages = Stages(normalized->GetNormalizationConverter(), doc["normalization"], "$.normalization");
    }
    if (!doc.HasMember("conversion_chain")) throw std::runtime_error("INVALID_CONFIG: Missing conversion chain");
    const auto main = Stages(converter, doc["conversion_chain"], "$.conversion_chain");
    stages.insert(stages.end(), main.begin(), main.end());
    for (const auto& stage : stages) {
      try { Scan(stage.conversion->GetDict(), *stage.dict, stage.path, stage.path + ".dict", report); }
      catch (...) {
        report.incomplete = true;
        report.reasons.push_back(stage.path + ": dictionary enumeration failed or exceeded its budget");
        break;
      }
    }
  } catch (...) {
    report.incomplete = true;
    report.reasons.push_back("Unable to enumerate every configured conversion stage");
  }
  try { return SerializeInspection(report); }
  catch (...) {
    report.incomplete = true;
    report.risks.clear();
    report.reasons.push_back("Risk details omitted: report serialization exceeded its budget or failed");
    return SerializeInspection(report);
  }
}
} // namespace selection
