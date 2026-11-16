// Small .xz files made with the xz command-line tool and Python's tarfile, for tests. bzip2 and
// zstd test data is built in code (src/fixtures/bzip2.ts, zstd.ts).
// small.tar: a PAX tar with the folder docs/ and docs/readme.txt ("hello from tar\n").

export const base64 = (text: string): Uint8Array => Uint8Array.from(atob(text), (c) => c.charCodeAt(0))

export const smallTarXz = '/Td6WFoAAATm1rRGBMCQAYBQIQEWAAAAAAAAANpw6JHgJ/8AiF0AMhvIjnTRj4FD7r3JyknGj9/T8IbxuN23mcTk8iPdTivUCCLoV5EUeuUBCiHwBgwFmq3RcXp1/TwTjkMhk3XjBpjAA1jOXAYulUY/veh7NQpyH0HXAfSSprcsdPXmU7QeeekTIfdLK25vDwDr3GgU8/pG45/KijWdZnNBni/OOc8QWSRzSluRFADLFMVdpqkpNQABrAGAUAAAc7QOEbHEZ/sCAAAAAARZWg=='
export const helloXz = '/Td6WFoAAATm1rRGBMANCSEBFgAAAAAAAAAAAF9PM+QBAAhoZWxsbyB4egoAAAAAwUk6+mNSFFoAASkJZJIcHR+2830BAAAAAARZWg=='
// "hello xz\n" from the xz tool with options the viewer's decoder does not take: `--check=sha256`,
// `--lzma2=dict=1536MiB` and `--x86` (a BCJ filter).
export const sha256Xz = '/Td6WFoAAArh+wyhBMANCSEBFgAAAAAAAAAAAF9PM+QBAAhoZWxsbyB4egoAAAAA4EUX8ghN/4n7/C+2TBvOls9Y6d4R6wgYQiahA9pdWUgAAUEJy3M4sBibS5oBAAAAAApZWg=='
export const bigDictXz = '/Td6WFoAAATm1rRGBMANCSEBJQAAAAAAAAAAAGR292cBAAhoZWxsbyB4egoAAAAAwUk6+mNSFFoAASkJZJIcHR+2830BAAAAAARZWg=='
export const x86Xz = '/Td6WFoAAATm1rRGBMENCQQAIQEWAAAAAAAAADFSVDsBAAhoZWxsbyB4egoAAAAAwUk6+mNSFFoAASkJZJIcHR+2830BAAAAAARZWg=='
