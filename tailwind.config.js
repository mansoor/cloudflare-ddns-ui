/** @type {import('tailwindcss').Config} */
export default {
  content: ['./web/**/*.{html,js}'],
  darkMode: 'class',
  theme: {
    extend: {
      colors: {
        brand: {
          50: '#fff7ed',
          100: '#ffedd5',
          500: '#f6821f',
          600: '#e26e10',
          700: '#c05a0a',
        },
      },
      fontFamily: {
        sans: ['Inter', 'ui-sans-serif', 'system-ui', 'sans-serif'],
      },
    },
  },
  plugins: [],
};
