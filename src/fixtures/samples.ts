// Two small .xz files made with the xz command-line tool, for tests: they use what the test
// encoder cannot write. Other bzip2, xz and zstd test data is built in code (src/fixtures/).

export const base64 = (text: string): Uint8Array => Uint8Array.from(atob(text), (c) => c.charCodeAt(0))

// "hello xz\n" from the xz tool with options the viewer's decoder does not take: `--check=sha256`
// and `--x86` (a BCJ filter).
export const sha256Xz = '/Td6WFoAAArh+wyhBMANCSEBFgAAAAAAAAAAAF9PM+QBAAhoZWxsbyB4egoAAAAA4EUX8ghN/4n7/C+2TBvOls9Y6d4R6wgYQiahA9pdWUgAAUEJy3M4sBibS5oBAAAAAApZWg=='
export const x86Xz = '/Td6WFoAAATm1rRGBMENCQQAIQEWAAAAAAAAADFSVDsBAAhoZWxsbyB4egoAAAAAwUk6+mNSFFoAASkJZJIcHR+2830BAAAAAARZWg=='
