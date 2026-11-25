/** @type {import('tailwindcss').Config} */
module.exports = {
  // v3.5 全站深色：class 策略，由 appearance.js 在 <html> 上挂/摘 dark 类
  darkMode: 'class',
  content: [
    "./index.html",
    "./src/**/*.{js,jsx}",
  ],
  theme: {
    extend: {},
  },
  plugins: [],
}
