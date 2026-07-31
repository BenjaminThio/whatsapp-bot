import sys
from rembg import remove

def main() -> None:
    try:
        # 1. Read raw image bytes directly from the Node.js pipeline
        input_data = sys.stdin.buffer.read()

        if not input_data:
            print("Error: No input image provided.", file=sys.stderr)
            sys.exit(1)

        # 2. Let the AI strip the background
        output_data = remove(input_data)

        # 3. Prove to Pylance that the output is bytes, then write it
        if isinstance(output_data, bytes):
            sys.stdout.buffer.write(output_data)
            sys.stdout.flush()
        else:
            raise TypeError("Expected bytes from rembg, but got a different type.")

    except Exception as e:
        print(f"Error: {e}", file=sys.stderr)
        sys.exit(1)

if __name__ == "__main__":
    main()