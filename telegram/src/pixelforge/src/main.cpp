#include <vector>
#include <cstdint>
#include <fcntl.h>
#include <io.h>
#include <cstdio>

#define STB_IMAGE_IMPLEMENTATION
#include "stb_image.h"
#define STB_IMAGE_WRITE_IMPLEMENTATION
#include "stb_image_write.h"

using namespace std;

struct RGBA
{
    uint8_t r, g, b, a;

    RGBA() : r(0), g(0), b(0), a(255) {}
    RGBA(uint8_t _r, uint8_t _g, uint8_t _b) : r(_r), g(_g), b(_b), a(255) {}
    RGBA(uint8_t _r, uint8_t _g, uint8_t _b, uint8_t _a) : r(_r), g(_g), b(_b), a(_a) {}

    /*
    RGBA& operator*(unsigned int scalar) {
        r *= scalar;
        g *= scalar;
        b *= scalar;
        a *= scalar;

        return *this;
    }

    RGBA& operator+(RGBA other) {
        r += other.r;
        g += other.g;
        b += other.b;
        a += other.a;

        return *this;
    }
    */
};

struct RGB
{
    uint8_t r, g, b;

    RGB() : r(0), g(0), b(0) {}
    RGB(uint8_t _r, uint8_t _g, uint8_t _b) : r(_r), g(_g), b(_b) {}
    RGB(RGBA other) : r(other.r), g(other.g), b(other.b) {}

    RGB& operator*(float scalar) {
        r *= scalar;
        g *= scalar;
        b *= scalar;

        return *this;
    }

    RGB& operator+(RGB other) {
        r += other.r;
        g += other.g;
        b += other.b;

        return *this;
    }
};

class Img
{
private:
    unsigned int width;
    unsigned int height;
    vector<RGBA> pixels;

public:
    Img(const unsigned int w, const unsigned int h, const RGBA& color = { 0, 0, 0 }) : width(w), height(h) {
        pixels.resize(width * height, color);
    }

    Img(const char *path) {
        int w, h, c;

        unsigned char* data = stbi_load(path, &w, &h, &c, 4);

        if (data == nullptr) {}
            // cerr << "ERRRRRRRRR" << endl;

        width = w;
        height = h;
        pixels.resize(width * height);

        for (unsigned int i = 0; i < width * height; ++i)
        {
            pixels[i].r = data[i * 4 + 0];
            pixels[i].g = data[i * 4 + 1];
            pixels[i].b = data[i * 4 + 2];
            pixels[i].a = data[i * 4 + 3];
        }

        stbi_image_free(data);
    }

    void draw_rect(const unsigned int x1, const unsigned int y1, const unsigned int x2, const unsigned int y2, const RGBA& color)
    {
        for (unsigned int y = y1; y <= y2; ++y)
            for (unsigned int x = x1; x <= x2; ++x)
                pixels[y * width + x] = color;
    }

    void save_png(const char* filename)
    {
        stbi_write_png(filename, width, height, 4, pixels.data(), width * 4);
    }

    void save_jpg(const char* filename, const unsigned int quality = 100)
    {
        stbi_write_jpg(filename, width, height, 4, pixels.data(), quality);
    }

    void overlay(const Img& img, unsigned int x, unsigned int y)
    {
        for (unsigned int sy = 0; sy < img.height; ++sy)
        {
            for (unsigned int sx = 0; sx < img.width; ++sx)
            {
                unsigned int dest_x = x + sx;
                unsigned int dest_y = y + sy;

                if (dest_x >= width || dest_y >= height) continue;

                unsigned int src_idx = sy * img.width + sx;
                unsigned int dest_idx = dest_y * width + dest_x;

                uint8_t pixel_alpha = img.pixels[src_idx].a;

                switch (pixel_alpha) {
                    case 0:
                        continue;
                    case 255:
                        pixels[dest_idx] = img.pixels[src_idx];
                        continue;
                }

                RGB top_pixel = img.pixels[src_idx];
                float alpha = pixel_alpha / 255.0f;
                RGB bottom_pixel = pixels[dest_idx];
                RGB result = (top_pixel * alpha) + (bottom_pixel * (1.0f - alpha));

                pixels[dest_idx] = RGBA(result.r, result.g, result.b);
            }
        }
    }

    void write_to_std_out()
    {
        int len;

        unsigned char* png_data = stbi_write_png_to_mem(
            (unsigned char*)pixels.data(),
            width * 4,
            width,
            height,
            4,
            &len
        );

        if (png_data == NULL)
        {
            // cerr << "NOOOOOO!!!" << endl;
            return;
        }

        #ifdef _WIN32
        _setmode(_fileno(stdout), _O_BINARY);
        #endif

        fwrite(png_data, 1, len, stdout);
        free(png_data);
    }
};

enum class Piece: int {
    WHITE_PAWN,
    WHITE_ROOK,
    WHITE_KNIGHT,
    WHITE_BISHOP,
    WHITE_QUEEN,
    WHITE_KING,
    BLACK_PAWN,
    BLACK_ROOK,
    BLACK_KNIGHT,
    BLACK_BISHOP,
    BLACK_QUEEN,
    BLACK_KING
};

const unsigned int PIXELS_PER_SIDE = 60;
const unsigned int SQUARES_PER_SIDE = 8;

int main(int argc, char *argv[])
{
    if (argc < 2)
        return -1;

    Img img(PIXELS_PER_SIDE * SQUARES_PER_SIDE, PIXELS_PER_SIDE * SQUARES_PER_SIDE, { 255, 255, 255 });

    for (unsigned int y = 0; y < SQUARES_PER_SIDE; ++y)
    {
        for (unsigned int x = 0; x < SQUARES_PER_SIDE; ++x)
        {
            if ((x + y) % 2 != 0)
            {
                img.draw_rect(
                    PIXELS_PER_SIDE * x,
                    PIXELS_PER_SIDE * y,
                    PIXELS_PER_SIDE * x + PIXELS_PER_SIDE - 1,
                    PIXELS_PER_SIDE * y + PIXELS_PER_SIDE - 1,
                    { 128, 128, 128 }
                );
            }
        }
    }

    Img* sprite_cache[12] = { nullptr };

    for (int i = 2; i < argc; i++)
    {
        int x, y, id;

        sscanf(argv[i], "%d,%d:%d", &x, &y, &id);

        if (sprite_cache[id] == nullptr)
        {
            char sprite_path[512];

            snprintf(sprite_path, sizeof(sprite_path), "%s/%d.png", argv[1], id);
            sprite_cache[id] = new Img(sprite_path);
        }

        img.overlay(*sprite_cache[id], x * PIXELS_PER_SIDE, y * PIXELS_PER_SIDE);
    }

    // img.save_jpg("chess.jpg");
    img.write_to_std_out();

    for (unsigned int i = 0; i < 12; ++i)
    {
        if (sprite_cache[i] != nullptr)
            delete sprite_cache[i];
    }
    return 0;
}