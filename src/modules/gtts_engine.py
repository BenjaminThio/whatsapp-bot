# python -m nuitka --onefile gtts_engine.py
import sys
from gtts import gTTS

def main():
    if len(sys.argv) < 3:
        print("Error: Missing arguments. Usage: gtts_engine.exe <lang> <text>", file=sys.stderr)
        sys.exit(1)

    lang_code = sys.argv[1]
    text = sys.argv[2]
    
    try:
        tts = gTTS(text=text, lang=lang_code)
        tts.write_to_fp(sys.stdout.buffer)
    except Exception as e:
        print(f"Error: {e}", file=sys.stderr)
        sys.exit(1)

if __name__ == "__main__":
    main()