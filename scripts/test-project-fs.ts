/* Path-sanitization checks for project-fs writes (run: npx tsx scripts/test-project-fs.ts) */
import { writeProjectFile } from "../lib/client/project-fs";

// Minimal fake directory handle that records the segments it is asked for.
function fakeDir(writes: string[], prefix = ""): unknown {
  return {
    getDirectoryHandle: async (name: string, _opts?: unknown) =>
      fakeDir(writes, `${prefix}${name}/`),
    getFileHandle: async (name: string, _opts?: unknown) => ({
      createWritable: async () => ({
        write: async (content: string) => {
          writes.push(`${prefix}${name}=${content}`);
        },
        close: async () => {},
      }),
    }),
  };
}

let failures = 0;
async function expectWrite(path: string, expected: string) {
  const writes: string[] = [];
  await writeProjectFile(fakeDir(writes) as FileSystemDirectoryHandle, path, "x");
  const ok = writes[0] === `${expected}=x`;
  if (!ok) failures++;
  console.log(`${ok ? "PASS" : "FAIL"} write "${path}" -> ${writes[0] ?? "(none)"}`);
}
async function expectReject(path: string) {
  try {
    await writeProjectFile(fakeDir([]) as FileSystemDirectoryHandle, path, "x");
    failures++;
    console.log(`FAIL reject "${path}" — was allowed`);
  } catch {
    console.log(`PASS reject "${path}"`);
  }
}

(async () => {
  await expectWrite("index.html", "index.html");
  await expectWrite("src/app/page.tsx", "src/app/page.tsx");
  await expectWrite("./src/x.ts", "src/x.ts");
  await expectWrite("src\\win\\style.css", "src/win/style.css");
  await expectReject("../escape.txt");
  await expectReject("src/../../escape.txt");
  await expectReject("/etc/passwd");
  await expectReject("C:/Windows/system32/evil.dll");
  await expectReject("");
  process.exit(failures === 0 ? 0 : 1);
})();
