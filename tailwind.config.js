/** @type {import('tailwindcss').Config} */
module.exports = {
  content: [
    './src/pages/**/*.{js,ts,jsx,tsx,mdx}',
    './src/components/**/*.{js,ts,jsx,tsx,mdx}',
    './src/app/**/*.{js,ts,jsx,tsx,mdx}',
  ],
  theme: {
    extend: {
      colors: {
        'jamaica-green': '#009B3A',
        'jamaica-yellow': '#FED100',
        'jamaica-black': '#000000',
        'dark-gray': '#333333',
        'light-gray': '#f8f8f8',
      },
      fontFamily: {
        'sans': ['Poppins', 'sans-serif'],
        'display': ['Montserrat', 'sans-serif'],
      },
      backgroundImage: {
        'hero-pattern': "linear-gradient(rgba(0, 0, 0, 0.6), rgba(0, 0, 0, 0.6)), url('/images/hero-bg.jpg')",
      },
      animation: {
        'flag-wave': 'flagWave 5s infinite linear',
        'pulse-slow': 'pulse 2s infinite',
      },
      keyframes: {
        flagWave: {
          '0%, 100%': {
            clipPath: 'polygon(0 0, 50% 50%, 0 100%, 0 0, 100% 0, 50% 50%, 100% 100%, 0 100%, 100% 100%, 100% 0)',
          },
          '50%': {
            clipPath: 'polygon(0 0, 55% 45%, 0 100%, 0 0, 100% 0, 45% 55%, 100% 100%, 0 100%, 100% 100%, 100% 0)',
          },
        },
      },
    },
  },
  plugins: [],
} 