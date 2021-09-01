const fs = require("fs");
const path = require("path");
const glob = require("fast-glob");
const postcss = require("postcss");
const less = require("less");
const { createHash } = require("crypto");
const bundle = require("less-bundle-promise");
const NpmImportPlugin = require("less-plugin-npm-import");
const stripCssComments = require("strip-css-comments");
const addLocalIdentName = require("./postcss-less-plugin");
const { promisify } = require("util");
const readFile = promisify(fs.readFile);

let hashCache = "";
let cssCache = "";

/*
  Generated random hex color code
  e.g. #fe12ee
*/
function randomColor() {
  return "#" + (0x1000000 + Math.random() * 0xffffff).toString(16).substr(1, 6);
}

/*
  Recursively get the color code assigned to a variable e.g.
  @primary-color: #1890ff;
  @link-color: @primary-color;

  @link-color -> @primary-color ->  #1890ff
  Which means
  @link-color: #1890ff
*/
function getColor(varName, mappings) {
  const color = mappings[varName];
  if (color in mappings) {
    return getColor(color, mappings);
  }

  return color;
}

/*
  Read following files and generate color variables and color codes mapping
    - Ant design color.less, themes/default.less
    - Your own variables.less
  It will generate map like this
  {
    '@primary-color': '#00375B',
    '@info-color': '#1890ff',
    '@success-color': '#52c41a',
    '@error-color': '#f5222d',
    '@normal-color': '#d9d9d9',
    '@primary-6': '#1890ff',
    '@heading-color': '#fa8c16',
    '@text-color': '#cccccc',
    ....
  }
*/
function generateColorMap(content, customColorRegexArray = []) {
  return content
    .split("\n")
    .filter(line => line.startsWith("@") && line.indexOf(":") > -1)
    .reduce((prev, next) => {
      try {
        const matches = next.match(
          /(?=\S*['-])([@a-zA-Z0-9'-]+).*:[ ]{1,}(.*);/
        );
        if (!matches) {
          return prev;
        }

        let [, varName, color] = matches;
        if (color && color.startsWith("@")) {
          color = getColor(color, prev);
          if (!isValidColor(color, customColorRegexArray)) return prev;
          prev[varName] = color;
        } else if (isValidColor(color, customColorRegexArray)) {
          prev[varName] = color;
        }

        return prev;
      } catch (e) {
        console.log("e", e);
        return prev;
      }
    }, {});
}

/*
 This plugin will remove all css rules except those are related to colors
 e.g.
 Input:
 .body {
    font-family: 'Lato';
    background: #cccccc;
    color: #000;
    padding: 0;
    pargin: 0
 }

 Output:
  .body {
    background: #cccccc;
    color: #000;
 }
*/
const reducePlugin = postcss.plugin("reducePlugin", () => {
  const cleanRule = rule => {
    if (rule.selector.startsWith(".main-color .palatte-")) {
      rule.remove();
      return;
    }

    let removeRule = true;
    rule.walkDecls(decl => {
      if (String(decl.value).match(/url\(.*\)/g)) {
        decl.remove();
      }

      const matched = false;
      /*
      This block causing https://github.com/ant-design/ant-design/issues/24777
      if (decl.prop !== 'background' && decl.prop.includes('background') && !decl.prop.match(/^background-(.*)color$/ig)) {
        decl.remove();
        matched = true;
      }
      if (decl.prop !== 'border' && decl.prop.includes('border') && !decl.prop.match(/^border-(.*)color$/ig)) {
        decl.remove();
        matched = true;
      }
      if (['transparent', 'inherit', 'none', '0'].includes(decl.value)) {
        decl.remove();
        matched = true;
      }
      */
      if (
        !decl.prop.includes("color") &&
        !decl.prop.includes("background") &&
        !decl.prop.includes("border") &&
        !decl.prop.includes("box-shadow") &&
        !Number.isNaN(decl.value)
      ) {
        // If (!matched) decl.remove();
        decl.remove();
      } else {
        removeRule = matched ? removeRule : false;
      }
    });
    if (removeRule) {
      rule.remove();
    }
  };

  return css => {
    css.walkAtRules(atRule => {
      atRule.remove();
    });

    css.walkRules(cleanRule);

    css.walkComments(c => c.remove());
  };
});

function getMatches(string, regex) {
  const matches = {};
  let match;
  while ((match = regex.exec(string))) {
    if (match[2].startsWith("rgba") || match[2].startsWith("#")) {
      matches[`@${match[1]}`] = match[2];
    }
  }

  return matches;
}

/*
  This function takes less input as string and compiles into css.
*/
function render(text, paths) {
  return less.render(text, {
    paths: paths,
    javascriptEnabled: true,
    plugins: [new NpmImportPlugin({ prefix: "~" })]
  });
}

/*
  This funtion reads a less file and create an object with keys as variable names
  and values as variables respective values. e.g.
  //variabables.less
    @primary-color : #1890ff;
    @heading-color : #fa8c16;
    @text-color : #cccccc;

    to

    {
      '@primary-color' : '#1890ff',
      '@heading-color' : '#fa8c16',
      '@text-color' : '#cccccc'
    }

*/
async function getLessVars(filtPath) {
  const buf = await readFile(filtPath);
  const sheet = buf.toString();
  const lessVars = {};
  const matches = sheet.match(/@(.*:[^;]*)/g) || [];

  matches.forEach(variable => {
    const definition = variable.split(/:\s*/);
    const varName = definition[0].replace(/['"]+/g, "").trim();
    lessVars[varName] = definition.splice(1).join(":");
  });
  return lessVars;
}

/*
  This function take primary color palette name and returns @primary-color dependent value
  .e.g
  Input: @primary-1
  Output: color(~`colorPalette("@{primary-color}", ' 1 ')`)
*/
function getShade(varName) {
  let [, className, number] = varName.match(/(.*)-(\d)/);
  if (/primary-\d/.test(varName)) className = "@primary-color";
  return (
    'color(~`colorPalette("@{' +
    className.replace("@", "") +
    '}", ' +
    number +
    ")`)"
  );
}

/*
  This function takes color string as input and return true if string is a valid color otherwise returns false.
  e.g.
  isValidColor('#ffffff'); //true
  isValidColor('#fff'); //true
  isValidColor('rgba(0, 0, 0, 0.5)'); //true
  isValidColor('20px'); //false
*/
function isValidColor(color, customColorRegexArray = []) {
  if (color && color.includes("rgb")) return true;
  if (!color || color.match(/px/g)) return false;
  if (color.match(/colorPalette|fade/g)) return true;
  if (color.charAt(0) === "#") {
    color = color.substring(1);
    return (
      [3, 4, 6, 8].indexOf(color.length) > -1 && !isNaN(parseInt(color, 16))
    );
  }
  // eslint-disable-next-line
  const isColor = /^(rgb|hsl|hsv)a?\((\d+%?(deg|rad|grad|turn)?[,\s]+){2,3}[\s\/]*[\d\.]+%?\)$/i.test(
    color
  );
  if (isColor) return true;
  if (customColorRegexArray.length > 0) {
    return customColorRegexArray.reduce((prev, regex) => {
      return prev || regex.test(color);
    }, false);
  }

  return false;
}

async function compileAllLessFilesToCss(
  stylesDir,
  antdStylesDir,
  varPath,
  varMap = {}
) {
  /*
    Get all less files path in styles directory
    and then compile all to css and join
  */
  const stylesDirs = [].concat(stylesDir);
  let styles = [];
  const gg = stylesDirs.map(s => {
    return glob(path.join(s, "./**/*.less"));
  });
  const pss = await Promise.all(gg);
  styles = styles.concat(
    pss.reduce((acc, val) => acc.concat(val)),
    []
  );
  const csss = await Promise.all(
    styles.map(async filePath => {
      let fileContent = await readFileSyncProcess(filePath);
      // Removed imports to avoid duplicate styles due to reading file separately as well as part of parent file (which is importing)
      // if (avoidDuplicates) fileContent = fileContent.replace(/@import\ ["'](.*)["'];/g, '\n');
      const r = /@import ["'](.*)["'];/g;
      const directory = path.dirname(filePath);
      fileContent = fileContent.replace(r, function(
        match,
        importPath,
        index,
        content
      ) {
        if (!importPath.endsWith(".less")) {
          importPath += ".less";
        }

        const newPath = path.join(directory, importPath);
        // If imported path/file already exists in styles paths then replace import statement with empty line
        if (styles.indexOf(newPath) === -1) {
          return match;
        }

        return "";
      });
      Object.keys(varMap).forEach(varName => {
        fileContent = fileContent.replace(
          new RegExp(`(:.*)(${varName})`, "g"),
          (match, group, a) => {
            return match.replace(varName, varMap[varName]);
          }
        );
      });
      fileContent = `@import "${varPath}";\n${fileContent}`;
      // FileContent = `@import "~antd/lib/style/themes/default.less";\n${fileContent}`;
      return less
        .render(fileContent, {
          paths: [antdStylesDir].concat(stylesDir),
          filename: path.resolve(filePath),
          javascriptEnabled: true,
          plugins: [new NpmImportPlugin({ prefix: "~" })]
        })
        .then(res => {
          return res;
        })
        .catch(e => {
          console.error(`Error occurred compiling file ${filePath}`);
          console.error("Error", e);
          return "\n";
        });
    })
  );
  const hashes = {};

  return csss
    .map(c => {
      const css = stripCssComments(c.css || "", { preserve: false });
      const hashCode = createHash("sha1")
        .update(css)
        .digest("hex");
      if (hashCode in hashes) {
        return "";
      }

      hashes[hashCode] = hashCode;
      return css;
    })
    .join("\n");
}

/*
  This is main function which call all other functions to generate color.less file which contins all color
  related css rules based on Ant Design styles and your own custom styles
  By default color.less will be generated in /public directory
*/
async function generateTheme({
  antDir,
  antdStylesDir,
  stylesDir,
  varFile,
  themeVariables = ["@primary-color"],
  customColorRegexArray = []
}) {
  try {
    let antdPath;
    if (antdStylesDir) {
      antdPath = antdStylesDir;
    } else {
      antdPath = path.join(antDir, "lib");
    }

    const nodeModulesPath = path.join(
      antDir.slice(0, antDir.indexOf("node_modules")),
      "./node_modules"
    );
    /*
      StylesDir can be array or string
    */
    const stylesDirs = [].concat(stylesDir);
    let styles = [];
    const gg = stylesDirs.map(s => {
      return glob(path.join(s, "./**/*.less"));
    });
    const pss = await Promise.all(gg);
    styles = styles.concat(
      pss.reduce((acc, val) => acc.concat(val)),
      []
    );

    const antdStylesFile = path.join(antDir, "./dist/antd.less"); // Path.join(antdPath, './style/index.less');

    /*
      You own custom styles (Change according to your project structure)

      - stylesDir - styles directory containing all less files
      - varFile - variable file containing ant design specific and your own custom variables
    */
    varFile = varFile || path.join(antdPath, "./style/themes/default.less");

    let content = "";
    const ps = styles.map(filePath => {
      return readFileSyncProcess(filePath);
    });
    const pss2 = await Promise.all(ps);
    content = pss2.join("");

    const hashCode = createHash("sha1")
      .update(content)
      .digest("hex");
    if (hashCode === hashCache) {
      return cssCache;
    }

    hashCache = hashCode;
    let themeCompiledVars = {};
    let themeVars = themeVariables || ["@primary-color"];
    const lessPaths = [path.join(antdPath, "./style")].concat(stylesDir);

    const randomColors = {};
    const randomColorsVars = {};
    /*
    Ant Design Specific Files (Change according to your project structure)
    You can even use different less based css framework and create color.less for  that

    - antDir - ant design instalation path
    - entry - Ant Design less main file / entry file
    - styles - Ant Design less styles for each component

    1. Bundle all variables into one file
    2. process vars and create a color name, color value key value map
    3. Get variables which are part of theme
    4.
  */

    const varFileContent = await combineLess(varFile, nodeModulesPath);

    customColorRegexArray = [
      ...customColorRegexArray,
      ...[
        "color",
        "lighten",
        "darken",
        "saturate",
        "desaturate",
        "fadein",
        "fadeout",
        "fade",
        "spin",
        "mix",
        "hsv",
        "tint",
        "shade",
        "greyscale",
        "multiply",
        "contrast",
        "screen",
        "overlay"
      ].map(name => new RegExp(`${name}\(.*\)`))
    ];
    const mappings = Object.assign(
      generateColorMap(varFileContent, customColorRegexArray),
      await getLessVars(varFile)
    );
    let css = "";
    const PRIMARY_RANDOM_COLOR = "#123456";
    themeVars = themeVars.filter(
      name => name in mappings && !name.match(/(.*)-(\d)/)
    );
    themeVars.forEach(varName => {
      let color = randomColor();
      if (varName === "@primary-color") {
        color = PRIMARY_RANDOM_COLOR;
      } else {
        while (
          (randomColorsVars[color] && color === PRIMARY_RANDOM_COLOR) ||
          color === "#000000" ||
          color === "#ffffff"
        ) {
          color = randomColor();
        }
      }

      randomColors[varName] = color;
      randomColorsVars[color] = varName;
      css = `.${varName.replace("@", "")} { color: ${color}; }\n ${css}`;
    });

    let varsContent = "";
    themeVars.forEach(varName => {
      [1, 2, 3, 4, 5, 7, 8, 9, 10].forEach(key => {
        const name =
          varName === "@primary-color"
            ? `@primary-${key}`
            : `${varName}-${key}`;
        css = `.${name.replace("@", "")} { color: ${getShade(
          name
        )}; }\n ${css}`;
      });
      varsContent += `${varName}: ${randomColors[varName]};\n`;
    });

    // This is to compile colors
    // Put colors.less content first,
    // then add random color variables to override the variables values for given theme variables with random colors
    // Then add css containinf color variable classes
    const colorFileContent = await combineLess(
      path.join(antdPath, "./style/color/colors.less"),
      nodeModulesPath
    );
    css = `${colorFileContent}\n${varsContent}\n${css}`;

    let results = await render(css, lessPaths);
    css = results.css;
    css = css.replace(/(\/.*\/)/g, "");
    const regex = /.(?=\S*['-])([.a-zA-Z0-9'-]+)\ {\n {2}color: (.*);/g;
    themeCompiledVars = getMatches(css, regex);

    // Convert all custom user less files to css
    const userCustomCss = await compileAllLessFilesToCss(
      stylesDir,
      antdStylesDir,
      varFile,
      themeCompiledVars
    );

    let antLessContentBuf = await readFile(antdStylesFile);
    let antLessContent = antLessContentBuf.toString();

    const antdLess = await bundle({
      src: antdStylesFile
    });
    // Fs.writeFileSync('./antd.less', antdLess);
    // const antdLess = bundle(antdStylesFile, nodeModulesPath)
    let fadeMap = {};
    const fades = antdLess.match(/fade\(.*\)/g);
    if (fades) {
      fades.forEach(fade => {
        if (
          !fade.startsWith("fade(@black") &&
          !fade.startsWith("fade(@white") &&
          !fade.startsWith("fade(#") &&
          !fade.startsWith("fade(@color")
        ) {
          fadeMap[fade] = randomColor();
        }
      });
    }

    let varsCombined = "";
    themeVars.forEach(varName => {
      let color;
      if (/(.*)-(\d)/.test(varName)) {
        color = getShade(varName);
        return;
      }

      color = themeCompiledVars[varName];

      varsCombined = `${varsCombined}\n${varName}: ${color};`;
    });

    antLessContent = `${antLessContent}\n${varsCombined}`;

    const updatedFadeMap = {};
    Object.keys(fadeMap).forEach(fade => {
      antLessContent = antLessContent.replace(
        new RegExp(fade.replace("(", "\\(").replace(")", "\\)"), "g"),
        fadeMap[fade]
      );
    });
    fadeMap = { ...fadeMap, ...updatedFadeMap };

    const { css: antCss } = await render(antLessContent, [
      antdPath,
      antdStylesDir
    ]);
    // Console.log('antCss', userCustomCss)
    const allCss = `${antCss}\n${userCustomCss}`;
    results = await postcss([reducePlugin]).process(allCss, {
      from: antdStylesFile
    });
    css = results.css;

    Object.keys(fadeMap).forEach(fade => {
      css = css.replace(new RegExp(fadeMap[fade], "g"), fade);
    });

    Object.keys(themeCompiledVars).forEach(varName => {
      let color;
      if (/(.*)-(\d)/.test(varName)) {
        color = themeCompiledVars[varName];
        varName = getShade(varName);
      } else {
        color = themeCompiledVars[varName];
      }

      color = color.replace("(", "\\(").replace(")", "\\)");
      // Css = css.replace(new RegExp(`${color}` + ' *;', 'g'), `${varName};`);
      css = css.replace(new RegExp(color, "g"), `${varName}`);
    });

    // Handle special cases
    // https://github.com/mzohaibqc/antd-theme-webpack-plugin/issues/69
    // 1. Replace fade(@primary-color, 20%) value i.e. rgba(18, 52, 86, 0.2)
    css = css.replace(
      new RegExp("rgba\\(18, 52, 86, 0.2\\)", "g"),
      "fade(@primary-color, 20%)"
    );

    css = css.replace(/@[\w-_]+:\s*.*;[\/.]*/gm, "");

    // This is to replace \9 in Ant Design styles
    css = css.replace(/\\9/g, "");
    const antdDefault = await combineLess(
      path.join(antdPath, "./style/themes/default.less"),
      nodeModulesPath
    );
    css = `${css.trim()}\n${antdDefault}`;

    themeVars.reverse().forEach(varName => {
      css = css.replace(new RegExp(`${varName}( *):(.*);`, "g"), "");
      css = `${varName}: ${mappings[varName]};\n${css}\n`;
    });

    css = minifyCss(css);

    cssCache = css;
    return cssCache;
  } catch (error) {
    console.log("error", error);
    return "";
  }
}

module.exports = {
  generateTheme,
  isValidColor,
  getLessVars,
  randomColor,
  minifyCss,
  renderLessContent: render
};

function minifyCss(css) {
  // Removed all comments and empty lines
  css = css
    .replace(/\/\*[\s\S]*?\*\/|\/\/.*/g, "")
    .replace(/^\s*$(?:\r\n?|\n)/gm, "");

  /*
  Converts from

    .abc,
    .def {
      color: red;
      background: blue;
      border: grey;
    }

    to

    .abc,
    .def {color: red;
      background: blue;
      border: grey;
    }

  */
  css = css.replace(/\{(\r\n?|\n)\s+/g, "{");

  /*
  Converts from

  .abc,
  .def {color: red;
  }

  to

  .abc,
  .def {color: red;
    background: blue;
    border: grey;}

  */
  css = css.replace(/;(\r\n?|\n)\}/g, ";}");

  /*
  Converts from

  .abc,
  .def {color: red;
    background: blue;
    border: grey;}

  to

  .abc,
  .def {color: red;background: blue;border: grey;}

  */
  css = css.replace(/;(\r\n?|\n)\s+/g, ";");

  /*
Converts from

.abc,
.def {color: red;background: blue;border: grey;}

to

.abc, .def {color: red;background: blue;border: grey;}

*/
  css = css.replace(/,(\r\n?|\n)[.]/g, ", .");
  return css;
}

// Const removeColorCodesPlugin = postcss.plugin('removeColorCodesPlugin', () => {
//   const cleanRule = rule => {
//     let removeRule = true;
//     rule.walkDecls(decl => {
//       if (
//         !decl.value.includes('@')
//       ) {
//         decl.remove();
//       } else {
//         removeRule = false;
//       }
//     });
//     if (removeRule) {
//       rule.remove();
//     }
//   };
//   return css => {
//     css.walkRules(cleanRule);
//   };
// });

async function combineLess(filePath, nodeModulesPath) {
  const buf = await readFile(filePath);
  const fileContent = buf.toString();
  const directory = path.dirname(filePath);
  const ps = fileContent.split("\n").map(async line => {
    if (line.startsWith("@import")) {
      let importPath = line.match(/@import\ ["'](.*)["'];/)[1];
      if (!importPath.endsWith(".less")) {
        importPath += ".less";
      }

      let newPath = path.join(directory, importPath);
      if (importPath.startsWith("~")) {
        importPath = importPath.replace("~", "");
        newPath = path.join(nodeModulesPath, `./${importPath}`);
      }

      return combineLess(newPath, nodeModulesPath);
    }

    return line;
  });
  const pss = await Promise.all(ps);
  return pss.join("\n");
}

function readFileSyncProcess(filePath) {
  // Console.log('filePath:', filePath);
  // return fs.readFileSync(filePath).toString();
  return addLocalIdentName(filePath);
}