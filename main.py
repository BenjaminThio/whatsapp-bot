import os

TARGET_DIRECTORY = 'src' 
IGNORE_FOLDERS = {}
IGNORE_FILES = {}
ALLOWED_EXTENSIONS = {'.ts'}
OUTPUT_FILE = 'project_content_summary.txt'

def should_process(file_name, root):
    parts = os.path.normpath(root).split(os.sep)
    if any(ignored in parts for ignored in IGNORE_FOLDERS):
        return False

    if file_name in IGNORE_FILES:
        return False
    
    ext = os.path.splitext(file_name)[1].lower()
    return ext in ALLOWED_EXTENSIONS

def generate_project_summary(target_dir):
    if not os.path.exists(target_dir):
        print(f"Error: The directory '{target_dir}' does not exist.")
        return

    current_line = 1
    
    with open(OUTPUT_FILE, 'w', encoding='utf-8') as outfile:
        for root, dirs, files in os.walk(target_dir):
            dirs.sort()
            files.sort()
            
            for file in files:
                if should_process(file, root):
                    file_path = os.path.join(root, file)
                    rel_path = os.path.relpath(file_path, '.')
                    rel_path = rel_path.replace(os.sep, '/')
                    
                    try:
                        with open(file_path, 'r', encoding='utf-8') as infile:
                            content = infile.readlines()

                            outfile.write(f"{rel_path}\n")
                            outfile.write("```\n")

                            for line in content:
                                outfile.write(line)
                                current_line += 1

                            if content and not content[-1].endswith('\n'):
                                outfile.write('\n')
                                
                            outfile.write("```\n\n")

                            current_line += 3 
                            
                    except Exception as e:
                        print(f"Could not read {rel_path}: {e}")

    print(f"Successfully generated: {OUTPUT_FILE} from the '{target_dir}' directory.")

if __name__ == "__main__":
    generate_project_summary(TARGET_DIRECTORY)