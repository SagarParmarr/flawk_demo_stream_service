#!/bin/sh
set -eu
cd "$(dirname "$0")/.."
mkdir -p native/build
if command -v cmake >/dev/null 2>&1; then
  cmake -S native/persistent-publisher -B native/build
  cmake --build native/build
else
  # Equivalent build for developer machines without CMake.
  ${CXX:-c++} -std=c++17 -Wall -Wextra -Werror -Wno-unused-function -pthread \
    $(pkg-config --cflags libavformat libavcodec libavutil json-c) \
    native/persistent-publisher/main.cpp -o native/build/flawk-publisher \
    $(pkg-config --libs libavformat libavcodec libavutil json-c)
fi
native/build/flawk-publisher --version > native/build/dependencies.json
