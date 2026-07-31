file(GLOB TEST_SOURCES CONFIGURE_DEPENDS
    "${CMAKE_CURRENT_SOURCE_DIR}/*.cpp"
)

foreach(test_src ${TEST_SOURCES})
    get_filename_component(test_name ${test_src} NAME_WE)

    add_executable(${test_name} ${test_src})

    target_include_directories(${test_name}
        PRIVATE "${CMAKE_SOURCE_DIR}/include"
    )
    target_include_directories(${test_name}
        SYSTEM PRIVATE "${CMAKE_SOURCE_DIR}/third_party"
    )

    target_compile_features(${test_name} PRIVATE cxx_std_23)

    if(TARGET core)
        target_link_libraries(${test_name} PRIVATE core)
    endif()

    if(ENABLE_WARNINGS AND COMMAND set_project_warnings)
        set_project_warnings(${test_name})
    endif()
endforeach()