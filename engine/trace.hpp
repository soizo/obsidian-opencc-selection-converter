#pragma once

#include <limits>
#include <string>
#include <string_view>
#include "Converter.hpp"

namespace selection {
size_t CountScalars(std::string_view text,
                    size_t limit = std::numeric_limits<size_t>::max());
std::string Trace(const opencc::ConverterPtr& converter,
                  std::string_view config, std::string_view input);
std::string CheckLengths(const opencc::ConverterPtr& converter,
                         std::string_view config);
} // namespace selection
