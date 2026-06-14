/*
 * subprocess.ts — one robust, cross-platform way to run a Python script or a
 * native helper binary and pipe bytes through it.
 *
 * Solves two problems at once:
 *
 * 1. PORTABILITY. On Windows you run scripts through the bundled venv
 *    interpreter (.venv/Scripts/python.exe) or a compiled .exe. On Termux /
 *    Linux there's no venv and no .exe — you call the system `python` against
 *    the .py source directly. resolvePython() and runPythonScript() hide that
 *    difference so command files don't hardcode Windows paths.
 *
 * 2. ROBUSTNESS / SECURITY. Every spawn gets: existence checks before running,
 *    a hard timeout with SIGKILL, a "settled" guard so we never resolve/reject
 *    twice, full stderr capture surfaced in errors, and EPIPE-safe stdin
 *    writes. Previously only denoise.ts did all this; now everything does.
 */
import { spawn } from "node:child_process";
import path from "node:path";
import { existsSync } from "node:fs";

const isWindows = process.platform === "win32";

/**
 * Resolve the Python interpreter to use.
 *   - Windows: prefer the project venv (.venv/Scripts/python.exe) if it exists,
 *     else fall back to "python".
 *   - Linux / Termux / macOS: prefer a project venv (.venv/bin/python) if it
 *     exists, else "python3", else "python".
 *
 * `projectRoot` should point at the bot's root (where .venv lives).
 */
export function resolvePython(projectRoot: string): string {
    if (isWindows) {
        const venv = path.join(projectRoot, ".venv", "Scripts", "python.exe");
        return existsSync(venv) ? venv : "python";
    }
    const venv = path.join(projectRoot, ".venv", "bin", "python");
    if (existsSync(venv)) return venv;
    // No venv on Termux — system python. Prefer python3 if the bare `python`
    // doesn't exist (some distros only ship python3).
    return "python3";
}

export interface RunOptions {
    /** Bytes to write to the child's stdin. Omit if the child takes args only. */
    input?: Buffer;
    /** Extra CLI args passed after the script path. */
    args?: string[];
    /** Milliseconds before we SIGKILL the child. Default 60s. */
    timeoutMs?: number;
    /** Label used in log lines, e.g. "denoise" → "🐍 [denoise] ...". */
    label?: string;
    /** Extra environment variables merged over process.env. */
    env?: Record<string, string>;
}

/**
 * Core runner: spawn `command` with `args`, optionally pipe `input` to stdin,
 * collect stdout as a Buffer, surface stderr in errors. Resolves with the
 * stdout bytes on exit code 0.
 */
export function runProcess(command: string, baseArgs: string[], opts: RunOptions = {}): Promise<Buffer> {
    const {
        input,
        args = [],
        timeoutMs = 60_000,
        label = "proc",
        env = {},
    } = opts;

    return new Promise((resolve, reject) => {
        const allArgs = [...baseArgs, ...args];
        const worker = spawn(command, allArgs, {
            env: { ...process.env, PYTHONUNBUFFERED: "1", ...env },
        });

        const stdoutChunks: Buffer[] = [];
        let stderrText = "";
        let settled = false;

        const timer = setTimeout(() => {
            if (settled) return;
            settled = true;
            console.error(`🐍 [${label}] timed out after ${timeoutMs / 1000}s — killing process`);
            try { worker.kill("SIGKILL"); } catch { /* already dead */ }
            reject(new Error(`${label} timed out after ${timeoutMs / 1000}s.\nStderr:\n${stderrText.trim() || "(empty)"}`));
        }, timeoutMs);

        worker.stdout.on("data", (chunk: Buffer) => stdoutChunks.push(chunk));

        worker.stderr.on("data", (chunk: Buffer) => {
            const text = chunk.toString("utf8");
            stderrText += text;
            process.stderr.write(`🐍 [${label}] ${text}`);
        });

        worker.stdin.on("error", (err: any) => {
            if (err.code !== "EPIPE") console.error(`🐍 [${label}] stdin error:`, err);
            // EPIPE = child died before reading input; stderr will explain why
        });

        worker.on("error", (err) => {
            if (settled) return;
            settled = true;
            clearTimeout(timer);
            reject(new Error(`Failed to spawn ${label} (${command}): ${err.message}`));
        });

        worker.on("close", (code, signal) => {
            if (settled) return;
            settled = true;
            clearTimeout(timer);

            if (code === 0) {
                const out = Buffer.concat(stdoutChunks);
                if (out.length === 0) {
                    return reject(new Error(`${label} exited cleanly but produced no output. Stderr:\n${stderrText.trim() || "(empty)"}`));
                }
                return resolve(out);
            }

            const err = stderrText.trim() || "(no stderr — likely a crash before any handler ran)";
            reject(new Error(
                `${label} exited with code ${code}${signal ? ` (signal ${signal})` : ""}.\n` +
                `--- stderr ---\n${err}\n--- end ---`
            ));
        });

        // Pipe input after handlers are attached
        if (input) {
            worker.stdin.write(input, (err) => {
                if (err && (err as any).code !== "EPIPE") {
                    console.error(`🐍 [${label}] stdin write error:`, err);
                }
            });
        }
        worker.stdin.end();
    });
}

/**
 * Run a Python script cross-platform. Resolves the interpreter automatically,
 * checks the script exists, and runs it through runProcess.
 *
 *   runPythonScript(projectRoot, "src/modules/denoise_engine.py", {
 *       input: audioBuffer, label: "denoise", timeoutMs: 120000
 *   })
 */
export function runPythonScript(projectRoot: string, scriptPath: string, opts: RunOptions = {}): Promise<Buffer> {
    const python = resolvePython(projectRoot);

    if (!existsSync(scriptPath)) {
        return Promise.reject(new Error(`Python script not found: ${scriptPath}`));
    }
    // If we resolved to an absolute venv interpreter, make sure it's actually there.
    if (path.isAbsolute(python) && !existsSync(python)) {
        return Promise.reject(new Error(`Python interpreter not found: ${python}`));
    }

    return runProcess(python, [scriptPath], opts);
}

/**
 * Run a native helper. On Windows this is typically a compiled .exe; on
 * Linux/Termux it's either a compiled binary (no extension) OR a Python script
 * we run via the interpreter.
 *
 * Pass both candidate paths and the function picks the right one:
 *   - Windows: use `winExe` if it exists, else fall back to the python script
 *   - else:    use `pyScript` via the system interpreter
 *
 * This lets the SAME command code run the .exe on your Windows dev box and the
 * .py source on the Termux phone with zero changes.
 */
export function runHelper(
    projectRoot: string,
    opts: {
        winExe: string;       // path to the compiled .exe (Windows)
        pyScript: string;     // path to the .py source (cross-platform fallback)
    } & RunOptions,
): Promise<Buffer> {
    const { winExe, pyScript, ...runOpts } = opts;

    if (isWindows && existsSync(winExe)) {
        return runProcess(winExe, [], runOpts);
    }
    // Non-Windows, or the .exe is missing → run the Python source
    return runPythonScript(projectRoot, pyScript, runOpts);
}