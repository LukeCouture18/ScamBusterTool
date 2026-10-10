import zipfile
import os
import sys
import tempfile
import shutil

def create_project_zip(output_path='public/project-archive.zip'):
    exclude_dirs = {'.git', 'node_modules', 'dist', '.cache', '__pycache__', 'coverage'}
    exclude_files = {'project-archive.zip'}
    
    # Resolve absolute paths
    abs_output = os.path.abspath(output_path)
    os.makedirs(os.path.dirname(abs_output), exist_ok=True)
    
    with tempfile.NamedTemporaryFile(suffix='.zip', delete=False) as tmp:
        temp_zip = tmp.name
        
    try:
        with zipfile.ZipFile(temp_zip, 'w', zipfile.ZIP_DEFLATED) as zipf:
            for root, dirs, files in os.walk('.'):
                dirs[:] = [d for d in dirs if d not in exclude_dirs and not d.startswith('.')]
                for file in files:
                    if file in exclude_files or file.startswith('.') or file.endswith('.tmp'):
                        continue
                    file_path = os.path.join(root, file)
                    arcname = os.path.relpath(file_path, '.')
                    zipf.write(file_path, arcname)
                    
        shutil.move(temp_zip, abs_output)
        print(f"Zip successfully created at {abs_output} ({os.path.getsize(abs_output)} bytes)")
    except Exception as e:
        if os.path.exists(temp_zip):
            os.remove(temp_zip)
        raise e

if __name__ == '__main__':
    target = sys.argv[1] if len(sys.argv) > 1 else 'public/project-archive.zip'
    create_project_zip(target)
