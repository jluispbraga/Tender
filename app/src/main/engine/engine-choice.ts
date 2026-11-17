// What the engine_choice setting accepts. Kept apart from engines.ts so the
// settings schema (and its unit tests) don't pull in WSL or Electron code.

export const AUTO = 'auto'
export const ADDRESS = /^(npipe|unix|tcp|ssh):\/\/.+/

export const validChoice = (c: string) => c === AUTO || /^wsl:\/\/[A-Za-z0-9._-]{1,64}$/.test(c) || /^context:\/\/[A-Za-z0-9._-]{1,128}$/.test(c) || (ADDRESS.test(c) && c.length <= 500)
