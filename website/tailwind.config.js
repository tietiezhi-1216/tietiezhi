module.exports = {
  content: ["./public/**/*.html", "./public/**/*.js"],
  theme: {
    colors: {
      transparent: "transparent",
      secondary: "#F4F2ED",
      black: "black",
      white: "white",
    },
    fontFamily: {
      "pt-serif": ['"PT Serif"', '"Songti SC"', '"Noto Serif SC"', "serif"],
      montserrat: ["Montserrat", '"PingFang SC"', '"Hiragino Sans GB"', '"Microsoft YaHei"', '"Noto Sans SC"', "sans-serif"],
    },
    backgroundSize: {
      auto: "auto",
      cover: "cover",
      contain: "contain",
      "100%": "100%",
    },
    extend: {
      backgroundImage: {
        underline1: "url('./assets/Underline1.svg')",
        underline2: "url('./assets/Underline2.svg')",
        underline3: "url('./assets/Underline3.svg')",
        underline4: "url('./assets/Underline4.svg')",
        highlight3: "url('./assets/Highlight3.svg')",
      },
      keyframes: {
        "fade-in-down": {
          "0%": {
            opacity: "0",
            transform: "translateY(-10px)",
          },
          "100%": {
            opacity: "1",
            transform: "translateY(0)",
          },
        },
        "title-shine": {
          "0%, 16%": {
            backgroundPosition: "145% 50%",
          },
          "54%, 100%": {
            backgroundPosition: "-55% 50%",
          },
        },
        "title-beam": {
          "0%, 16%": {
            opacity: "0",
            transform: "translate3d(-140%, 0, 0) skewX(-8deg)",
          },
          "24%": {
            opacity: ".08",
          },
          "38%": {
            opacity: ".16",
          },
          "54%, 100%": {
            opacity: "0",
            transform: "translate3d(820%, 0, 0) skewX(-8deg)",
          },
        },
        "star-drift": {
          "0%": {
            transform: "translate3d(-1.5%, -1%, 0) scale(1.02)",
          },
          "50%": {
            opacity: ".72",
          },
          "100%": {
            transform: "translate3d(1.5%, 1%, 0) scale(1.06)",
          },
        },
        "star-drift-reverse": {
          "0%": {
            transform: "translate3d(1%, -1%, 0) scale(1.03) rotate(180deg)",
          },
          "100%": {
            transform: "translate3d(-1%, 1.5%, 0) scale(1.08) rotate(180deg)",
          },
        },
        "page-sweep": {
          "0%, 12%": {
            opacity: "0",
            transform: "translate3d(-35vw, 0, 0) skewX(-8deg)",
          },
          "20%": {
            opacity: ".2",
          },
          "43%": {
            opacity: ".12",
          },
          "52%, 100%": {
            opacity: "0",
            transform: "translate3d(145vw, 0, 0) skewX(-8deg)",
          },
        },
      },
      animation: {
        "fade-in-down": "fade-in-down 0.5s ease-out",
        "title-shine": "title-shine 5.2s linear infinite",
        "title-beam": "title-beam 5.2s linear infinite",
        "star-drift": "star-drift 18s ease-in-out infinite alternate",
        "star-drift-reverse": "star-drift-reverse 24s ease-in-out infinite alternate",
        "page-sweep": "page-sweep 8s ease-in-out infinite",
      },
    },
  },
  variants: {
    extend: {},
  },
  plugins: [],
};
