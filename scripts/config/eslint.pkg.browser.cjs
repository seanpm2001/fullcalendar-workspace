
module.exports = {
  extends: [
    './eslint.base.cjs',
  ],
  ignorePatterns: [
    'dist',
  ],
  overrides: [
    {
      files: [
        './*.{js,cjs}',
        './{scripts,config}/**/*.{js,cjs}',
      ],
      env: {
        node: true,
      },
    },
    {
      files: [
        './{src,tests}/**/*.{js,ts,jsx,tsx}',
      ],
      env: {
        browser: true,
      },
    },
  ],
}
