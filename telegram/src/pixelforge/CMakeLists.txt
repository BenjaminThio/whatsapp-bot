cmake_minimum_required(VERSION 3.20)

project(App VERSION 1.0.0 LANGUAGES CXX)

#
# Chess board renderer - native N-API addon.
#
# One file for every host. It detects the compiler and the CPU rather than
# needing a separate CMakeLists per platform:
#
#   Termux / Linux ARM64   clang or gcc, -O3 + -mcpu=native
#   Linux x86-64           clang or gcc, -O3 + -march=native
#   Windows MinGW (g++)    -O3, no -march=native (see the note below)
#   Windows MSVC           /O2 /fp:fast
#
# Build:
#   npx cmake-js compile --CDCMAKE_BUILD_TYPE=Release
#   npx cmake-js compile -G Ninja --CDCMAKE_BUILD_TYPE=Release      # faster
#
# The previous per-platform files are kept as CMakeLists-linux-original.txt,
# CMakeLists1.txt, CMakeLists2.txt and CMakeLists-MSVC.txt for reference.
#

set(CMAKE_CXX_STANDARD 20)
set(CMAKE_CXX_STANDARD_REQUIRED ON)
set(CMAKE_CXX_EXTENSIONS OFF)
set(CMAKE_EXPORT_COMPILE_COMMANDS ON)

if(NOT CMAKE_BUILD_TYPE)
    set(CMAKE_BUILD_TYPE Release CACHE STRING "" FORCE)
endif()

# ── node-addon-api headers ────────────────────────────────────────────────────

execute_process(
    COMMAND node -p "require('node-addon-api').include_dir"
    WORKING_DIRECTORY ${CMAKE_SOURCE_DIR}
    OUTPUT_VARIABLE NODE_ADDON_API_DIR
    OUTPUT_STRIP_TRAILING_WHITESPACE
    ERROR_QUIET
)
if(NOT NODE_ADDON_API_DIR)
    # Older node-addon-api exposes `.include` instead of `.include_dir`
    execute_process(
        COMMAND node -p "require('node-addon-api').include"
        WORKING_DIRECTORY ${CMAKE_SOURCE_DIR}
        OUTPUT_VARIABLE NODE_ADDON_API_DIR
        OUTPUT_STRIP_TRAILING_WHITESPACE
    )
endif()
string(REGEX REPLACE "[\r\n\"]" "" NODE_ADDON_API_DIR "${NODE_ADDON_API_DIR}")

# C++ exceptions are disabled below, so N-API must report errors by other means
add_compile_definitions(NAPI_DISABLE_CPP_EXCEPTIONS NAPI_VERSION=8)

#
# MinGW cannot link what cmake-js hands it.
#
# cmake-js assumes MSVC on Windows and injects `/DELAYLOAD:NODE.EXE` plus a
# delay-load hook written against the MSVC runtime. GNU ld reads the flag as a
# filename and fails with "cannot find /DELAYLOAD:NODE.EXE". Neither is needed:
# the delay-load trick exists so an addon can be loaded by an Electron binary
# that isn't node.exe, which does not apply here.
#
if(MINGW)
    set(CMAKE_SHARED_LINKER_FLAGS "" CACHE STRING "" FORCE)
    set(CMAKE_JS_SRC "")
    message(STATUS ">> MinGW: dropped cmake-js delay-load hook and MSVC linker flags")
endif()

add_library(${PROJECT_NAME} SHARED
    "${CMAKE_SOURCE_DIR}/src/addon.cpp"
    ${CMAKE_JS_SRC}
)

target_include_directories(${PROJECT_NAME} PRIVATE
    "${CMAKE_SOURCE_DIR}/include"
    "${CMAKE_SOURCE_DIR}/third_party"
    ${CMAKE_JS_INC}
    ${NODE_ADDON_API_DIR}
)

target_link_libraries(${PROJECT_NAME} PRIVATE ${CMAKE_JS_LIB})
set_target_properties(${PROJECT_NAME} PROPERTIES PREFIX "" SUFFIX ".node")

#
# Always emit build/Release/App.node.
#
# Multi-config generators (Visual Studio) append the config themselves, while
# single-config ones (Ninja, Unix/MinGW Makefiles) write straight into the build
# root - so the addon landed in a different place depending on how you built it,
# and the require() path only worked for one of them. Pinning all three output
# variables, plus the per-config overrides, makes the location the same
# everywhere.
#
set(ADDON_OUT "${CMAKE_BINARY_DIR}/Release")
set_target_properties(${PROJECT_NAME} PROPERTIES
    RUNTIME_OUTPUT_DIRECTORY "${ADDON_OUT}"
    LIBRARY_OUTPUT_DIRECTORY "${ADDON_OUT}"
)
foreach(cfg IN ITEMS DEBUG RELEASE RELWITHDEBINFO MINSIZEREL)
    set_target_properties(${PROJECT_NAME} PROPERTIES
        RUNTIME_OUTPUT_DIRECTORY_${cfg} "${ADDON_OUT}"
        LIBRARY_OUTPUT_DIRECTORY_${cfg} "${ADDON_OUT}"
    )
endforeach()

if(MSVC)
    target_link_libraries(${PROJECT_NAME} PRIVATE delayimp.lib)
endif()

# ── Link-time optimisation ────────────────────────────────────────────────────

include(CheckIPOSupported)
check_ipo_supported(RESULT ipo_supported OUTPUT ipo_error)

if(ipo_supported AND CMAKE_BUILD_TYPE MATCHES "Release|MinSizeRel")
    set_property(TARGET ${PROJECT_NAME} PROPERTY INTERPROCEDURAL_OPTIMIZATION TRUE)
    message(STATUS ">> LTO enabled")
else()
    message(STATUS ">> LTO unavailable: ${ipo_error}")
endif()

# ── Optimisation ──────────────────────────────────────────────────────────────

if(CMAKE_BUILD_TYPE MATCHES "Release|MinSizeRel")
    target_compile_definitions(${PROJECT_NAME} PRIVATE NDEBUG STBI_NO_FAILURE_STRINGS)

    if(MSVC)
        message(STATUS ">> MSVC build")
        target_compile_options(${PROJECT_NAME} PRIVATE
            /O2 /Oi /Ot        # speed, intrinsics, favour fast code
            /fp:fast
            /GS-               # no stack cookies; this is pure pixel work
            /Gw /Gy            # per-variable and per-function COMDATs for /OPT
            /EHs-c- /GR-       # no exceptions, no RTTI - matches NAPI_DISABLE_CPP_EXCEPTIONS
        )
        target_link_options(${PROJECT_NAME} PRIVATE /OPT:REF /OPT:ICF)
    else()
        target_compile_options(${PROJECT_NAME} PRIVATE
            -O3
            -fno-exceptions       # NAPI_DISABLE_CPP_EXCEPTIONS is set, so unwinding is dead weight
            -fno-rtti
            -fomit-frame-pointer
            -ffunction-sections   # let the linker drop what it can
            -fdata-sections
            -fvisibility=hidden   # only the N-API entry point needs to be exported
        )

        #
        # -ffast-math is deliberately NOT used. Every hot path here is integer
        # pixel arithmetic, so it buys nothing, and it would silently change
        # float semantics for anything added later.
        #

        include(CheckCXXCompilerFlag)

        if(CMAKE_SYSTEM_PROCESSOR MATCHES "aarch64|arm64|armv8")
            # Termux on a phone: build and run are the same CPU, so native is safe
            check_cxx_compiler_flag("-mcpu=native" HAS_MCPU_NATIVE)
            if(HAS_MCPU_NATIVE)
                target_compile_options(${PROJECT_NAME} PRIVATE -mcpu=native)
                message(STATUS ">> ARM64 build, -mcpu=native")
            else()
                message(STATUS ">> ARM64 build, generic tuning")
            endif()
        elseif(WIN32)
            #
            # No -march=native on Windows MinGW. It emits AVX for code that Node
            # then loads into a process with a different baseline, and the crash
            # surfaces as a random segfault inside V8. The render is
            # memory-bound, so the flag buys very little here anyway.
            #
            message(STATUS ">> Windows MinGW build, generic x86-64 tuning")
        else()
            check_cxx_compiler_flag("-march=native" HAS_MARCH_NATIVE)
            if(HAS_MARCH_NATIVE)
                target_compile_options(${PROJECT_NAME} PRIVATE -march=native -mtune=native)
                message(STATUS ">> x86-64 build, -march=native")
            endif()
        endif()

        # Strip and garbage-collect. Apple's linker spells both differently.
        if(APPLE)
            target_link_options(${PROJECT_NAME} PRIVATE -Wl,-dead_strip)
        elseif(NOT WIN32)
            target_link_options(${PROJECT_NAME} PRIVATE -Wl,--gc-sections -Wl,-s)
        else()
            target_link_options(${PROJECT_NAME} PRIVATE -Wl,--gc-sections)
        endif()
    endif()

    message(STATUS ">> Release build: -O3 + LTO, exceptions and RTTI off")
endif()

message(STATUS ">> Target: ${CMAKE_SYSTEM_NAME}/${CMAKE_SYSTEM_PROCESSOR}, compiler ${CMAKE_CXX_COMPILER_ID}")
