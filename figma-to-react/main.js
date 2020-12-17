require('dotenv').config()
const fetch = require('node-fetch');
const fs = require('fs');
// const figma = require('./lib/figma');

const headers = new fetch.Headers();
const componentList = [];
let devToken = process.env.DEV_TOKEN;

if (process.argv.length < 3) {
  console.log('Usage: node setup.js <file-key> [figma-dev-token]');
  process.exit(0);
}

if (process.argv.length > 3) {
  devToken = process.argv[3];
}

headers.append('X-Figma-Token', devToken);

const fileKey = process.argv[2];
const baseUrl = 'https://api.figma.com';

const vectorMap = {};
const vectorList = [];
const vectorTypes = ['VECTOR', 'LINE', 'REGULAR_POLYGON', 'ELLIPSE', 'STAR'];

function preprocessTree(node) {
  let vectorsOnly = node.name.charAt(0) !== '#';
  let vectorVConstraint = null;
  let vectorHConstraint = null;

  function paintsRequireRender(paints) {
    if (!paints) return false;

    let numPaints = 0;
    for (const paint of paints) {
      if (paint.visible === false) continue;

      numPaints++;
      if (paint.type === 'EMOJI') return true;
    }

    return numPaints > 1;
  }

  if (paintsRequireRender(node.fills) ||
      paintsRequireRender(node.strokes) ||
      (node.blendMode != null && ['PASS_THROUGH', 'NORMAL'].indexOf(node.blendMode) < 0)) {
    node.type = 'VECTOR';
  }

  const children = node.children && node.children.filter((child) => child.visible !== false);
  if (children) {
    for (let j=0; j<children.length; j++) {
      if (vectorTypes.indexOf(children[j].type) < 0) vectorsOnly = false;
      else {
        if (vectorVConstraint != null && children[j].constraints.vertical != vectorVConstraint) vectorsOnly = false;
        if (vectorHConstraint != null && children[j].constraints.horizontal != vectorHConstraint) vectorsOnly = false;
        vectorVConstraint = children[j].constraints.vertical;
        vectorHConstraint = children[j].constraints.horizontal;
      }
    }
  }
  node.children = children;

  if (children && children.length > 0 && vectorsOnly) {
    node.type = 'VECTOR';
    node.constraints = {
      vertical: vectorVConstraint,
      horizontal: vectorHConstraint,
    };
  }

  if (vectorTypes.indexOf(node.type) >= 0) {
    node.type = 'VECTOR';
    vectorMap[node.id] = node;
    vectorList.push(node.id);
    node.children = [];
  }

  if (node.children) {
    for (const child of node.children) {
      preprocessTree(child);
    }
  }
}

async function main() {
  let resp = await fetch(`${baseUrl}/v1/files/${fileKey}`, {headers});
  let data = await resp.json();

  const doc = data.document;
  const canvas = doc.children[0];
  let html = '';

  for (let i=0; i<canvas.children.length; i++) {
    const child = canvas.children[i]
    if (child.name.charAt(0) === '#'  && child.visible !== false) {
      const child = canvas.children[i];
      preprocessTree(child);
    }
  }

  let guids = vectorList.join(',');
  data = await fetch(`${baseUrl}/v1/images/${fileKey}?ids=${guids}&format=svg`, {headers});
  const imageJSON = await data.json();

  const images = imageJSON.images || {};
  if (images) {
    let promises = [];
    let guids = [];
    for (const guid in images) {
      if (images[guid] == null) continue;
      guids.push(guid);
      promises.push(fetch(images[guid]));
    }

    let responses = await Promise.all(promises);
    promises = [];
    for (const resp of responses) {
      promises.push(resp.text());
    }

    responses = await Promise.all(promises);
    for (let i=0; i<responses.length; i++) {
      images[guids[i]] = responses[i].replace('<svg ', '<svg preserveAspectRatio="none" ');
    }
  }

  const componentMap = {};
  let contents = `import React, { PureComponent } from 'react';\n`;
  let nextSection = '';
  let name = '';

  for (let i=0; i<canvas.children.length; i++) {
    const child = canvas.children[i]
    if (child.name.charAt(0) === '#' && child.visible !== false) {
      const child = canvas.children[i];
      // const componentSrc = `import React, { PureComponent } from 'react';
      // import { getComponentFromId } from '../figmaComponents';
      
      // export class ${child.name.replace(/\W+/g, "")} extends PureComponent {
      //   state = {};
      
      //   render() {
      //     const Component = getComponentFromId(this.props.nodeId);
      //     return <Component {...this.props} {...this.state} />;
      //   }
      // }
      // `;
      //   nextSection += componentSrc;
      createComponent(child, images, componentMap);
      nextSection += `export class Master${child.name.replace(/\W+/g, "")} extends PureComponent {\n`;
      // nextSection += `export class ${child.name.replace(/\W+/g, "")} extends PureComponent {\n`;
      nextSection += "  render() {\n";
      nextSection += `    return <div className="master" style={{backgroundColor: "${colorString(child.backgroundColor)}"}}>\n`;
      nextSection += `      <${child.name.replace(/\W+/g, "")} />\n`;
      // nextSection += `      <${child.name.replace(/\W+/g, "")} {...this.props} nodeId="${child.id}" />\n`;
      nextSection += "    </div>\n";
      nextSection += "  }\n";
      nextSection += "}\n\n";
      name = child.name.replace(/\W+/g, "");
    }
  }
  // const imported = {};
  // for (const key in componentMap) {
  //   const component = componentMap[key];
  //   const name = component.name;
  //   if (!imported[name]) {
  //     contents += `import { ${name} } from './components/${name}';\n`;
  //   }
  //   imported[name] = true;
  // }
  contents += "\n";
  contents += nextSection;
  nextSection = '';
  
  // contents += `export function getComponentFromId(id) {\n`;
  for (const key in componentMap) {
  //   contents += `  if (id === "${key}") return ${componentMap[key].instance};\n`;
    nextSection += componentMap[key].doc + "\n";
  }
  // nextSection += componentMap[key].doc + "\n";
  // contents += "  return null;\n}\n\n";
  // nextSection += JSON.stringify(componentMap.doc);
  // nextSection += "\n";
  contents += nextSection;
  
  // const path = "./src/figmaComponents.js";
  // console.log(componentMap[1].name);
  // const name = componentMap[1].name;
  
  const path = `src/components/${name}.js`
  fs.writeFile(path, contents, function(err) {
    if (err) console.log(err);
    console.log(`wrote ${path}`);
  });
}

const VECTOR_TYPES = ['VECTOR', 'LINE', 'REGULAR_POLYGON', 'ELLIPSE'];
const GROUP_TYPES = ['GROUP', 'BOOLEAN_OPERATION'];

function colorString(color) {
  return `rgba(${Math.round(color.r*255)}, ${Math.round(color.g*255)}, ${Math.round(color.b*255)}, ${color.a})`;
}

function dropShadow(effect) {
  return `${effect.offset.x}px ${effect.offset.y}px ${effect.radius}px ${colorString(effect.color)}`;
}

function innerShadow(effect) {
  return `inset ${effect.offset.x}px ${effect.offset.y}px ${effect.radius}px ${colorString(effect.color)}`;
}

function imageURL(hash) {
  const squash = hash.split('-').join('');
  return `url(https://s3-us-west-2.amazonaws.com/figma-alpha/img/${squash.substring(0, 4)}/${squash.substring(4, 8)}/${squash.substring(8)})`;
}

function backgroundSize(scaleMode) {
  if (scaleMode === 'FILL') {
    return 'cover';
  }
}

function nodeSort(a, b) {
  if (a.absoluteBoundingBox.y < b.absoluteBoundingBox.y) return -1;
  else if (a.absoluteBoundingBox.y === b.absoluteBoundingBox.y) return 0;
  else return 1;
}

function getPaint(paintList) {
  if (paintList && paintList.length > 0) {
    return paintList[paintList.length - 1];
  }

  return null;
}

function paintToLinearGradient(paint) {
  const handles = paint.gradientHandlePositions;
  const handle0 = handles[0];
  const handle1 = handles[1];

  const ydiff = handle1.y - handle0.y;
  const xdiff = handle0.x - handle1.x;

  const angle = Math.atan2(-xdiff, -ydiff);
  const stops = paint.gradientStops.map((stop) => {
    return `${colorString(stop.color)} ${Math.round(stop.position * 100)}%`;
  }).join(', ');
  return `linear-gradient(${angle}rad, ${stops})`;
}

function paintToRadialGradient(paint) {
  const stops = paint.gradientStops.map((stop) => {
    return `${colorString(stop.color)} ${Math.round(stop.position * 60)}%`;
  }).join(', ');

  return `radial-gradient(${stops})`;
}

function expandChildren(node, parent, minChildren, maxChildren, centerChildren, offset) {
  const children = node.children;
  let added = offset;

  if (children) {
    for (let i=0; i<children.length; i++) {
      const child = children[i];

      if (parent != null && (node.type === 'COMPONENT' || node.type === 'INSTANCE')) {
        child.constraints = {vertical: 'TOP_BOTTOM', horizontal: 'LEFT_RIGHT'};
      }

      if (GROUP_TYPES.indexOf(child.type) >= 0) {
        added += expandChildren(child, parent, minChildren, maxChildren, centerChildren, added+i);
        continue;
      }

      child.order = i + added;

      if (child.constraints && child.constraints.vertical === 'BOTTOM') {
        maxChildren.push(child);
      } else if (child.constraints && child.constraints.vertical === 'TOP') {
        minChildren.push(child);
      } else {
        centerChildren.push(child);
      }
    }

    minChildren.sort(nodeSort);
    maxChildren.sort(nodeSort);

    return added + children.length - offset;
  }

  return added - offset;
}

const createComponent = (component, imgMap, componentMap) => {
  const name = component.name.replace(/\W+/g, '');
  const instance = name + component.id.replace(';', 'S').replace(':', 'D');

  let doc = '';
  print(`class ${name} extends PureComponent {`, '');
  // print(`class ${instance} extends PureComponent {`, '');
  print(`  render() {`, '');
  print(`    return (`, '');

  //  const path = `src/components/${name}.js`;

  // if (!fs.existsSync(path)) {
//     const componentSrc = `import React, { PureComponent } from 'react';
// import { getComponentFromId } from '../figmaComponents';

// export class ${name} extends PureComponent {
//   state = {};

//   render() {
//     const Component = getComponentFromId(this.props.nodeId);
//     return <Component {...this.props} {...this.state} />;
//   }
// }
// `;
//   nextSection += componentSrc;
    // fs.writeFile(path, componentSrc, function(err) {
    //   if (err) console.log(err);
    //   console.log(`wrote ${path}`);
    // });
  // }

  function print(msg, indent) {
    doc += `${indent}${msg}\n`;
  }

  const visitNode = (node, parent, lastVertical, indent) => {
    let content = null;
    let img = null;
    const styles = {};
    let minChildren = [];
    const maxChildren = [];
    const centerChildren = [];
    let bounds = null;
    let nodeBounds = null;

    if (parent != null) {
      nodeBounds = node.absoluteBoundingBox;
      const nx2 = nodeBounds.x + nodeBounds.width;
      const ny2 = nodeBounds.y + nodeBounds.height;
      const parentBounds = parent.absoluteBoundingBox;
      const px = parentBounds.x;
      const py = parentBounds.y;

      bounds = {
        left: nodeBounds.x - px,
        right: px + parentBounds.width - nx2,
        top: lastVertical == null ? nodeBounds.y - py : nodeBounds.y - lastVertical,
        bottom: py + parentBounds.height - ny2,
        width: nodeBounds.width,
        height: nodeBounds.height,
      }
    }

    expandChildren(node, parent, minChildren, maxChildren, centerChildren, 0);

    let outerClass = 'outerDiv';
    let innerClass = 'innerDiv';
    const cHorizontal = node.constraints && node.constraints.horizontal;
    const cVertical = node.constraints && node.constraints.vertical;
    const outerStyle = {};

    if (node.order) {
      outerStyle.zIndex = node.order;
    }

    if (cHorizontal === 'LEFT_RIGHT') {
      if (bounds != null) {
        styles.marginLeft = bounds.left;
        styles.marginRight = bounds.right;
        styles.flexGrow = 1;
      }
    } else if (cHorizontal === 'RIGHT') {
      outerStyle.justifyContent = 'flex-end';
      if (bounds != null) {
        styles.marginRight = bounds.right;
        styles.width = bounds.width;
        styles.minWidth = bounds.width;
      }
    } else if (cHorizontal === 'CENTER') {
      outerStyle.justifyContent = 'center';
      if (bounds != null) {
        styles.width = bounds.width;
        styles.marginLeft = bounds.left && bounds.right ? bounds.left - bounds.right : null;
      }
    } else if (cHorizontal === 'SCALE') {
      if (bounds != null) {
        const parentWidth = bounds.left + bounds.width + bounds.right;
        styles.width = `${bounds.width*100/parentWidth}%`;
        styles.marginLeft = `${bounds.left*100/parentWidth}%`;
      }
    } else {
      if (bounds != null) {
        styles.marginLeft = bounds.left;
        styles.width = bounds.width;
        styles.minWidth = bounds.width;
      }
    }

    if (bounds && bounds.height && cVertical !== 'TOP_BOTTOM') styles.height = bounds.height;
    if (cVertical === 'TOP_BOTTOM') {
      outerClass += ' centerer';
      if (bounds != null) {
        styles.marginTop = bounds.top;
        styles.marginBottom = bounds.bottom;
      }
    } else if (cVertical === 'CENTER') {
      outerClass += ' centerer';
      outerStyle.alignItems = 'center';
      if (bounds != null) {
        styles.marginTop = bounds.top - bounds.bottom;
      }
    } else if (cVertical === 'SCALE') {
      outerClass += ' centerer';
      if (bounds != null) {
        const parentHeight = bounds.top + bounds.height + bounds.bottom;
        styles.height = `${bounds.height*100/parentHeight}%`;
        styles.top = `${bounds.top*100/parentHeight}%`;
      }
    } else {
      if (bounds != null) {
        styles.marginTop = bounds.top;
        styles.marginBottom = bounds.bottom;
        styles.minHeight = styles.height;
        styles.height = null;
      }
    }

    if (['FRAME', 'RECTANGLE', 'INSTANCE', 'COMPONENT'].indexOf(node.type) >= 0) {
      if (['FRAME', 'COMPONENT', 'INSTANCE'].indexOf(node.type) >= 0) {
        styles.backgroundColor = colorString(node.backgroundColor);
        if (node.clipsContent) styles.overflow = 'hidden';
      } else if (node.type === 'RECTANGLE') {
        const lastFill = getPaint(node.fills);
        if (lastFill) {
          if (lastFill.type === 'SOLID') {
            styles.backgroundColor = colorString(lastFill.color);
            styles.opacity = lastFill.opacity;
          } else if (lastFill.type === 'IMAGE') {
            styles.backgroundImage = imageURL(lastFill.imageRef);
            styles.backgroundSize = backgroundSize(lastFill.scaleMode);
          } else if (lastFill.type === 'GRADIENT_LINEAR') {
            styles.background = paintToLinearGradient(lastFill);
          } else if (lastFill.type === 'GRADIENT_RADIAL') {
            styles.background = paintToRadialGradient(lastFill);
          }
        }

        if (node.effects) {
          for (let i=0; i<node.effects.length; i++) {
            const effect = node.effects[i];
            if (effect.type === 'DROP_SHADOW') {
              styles.boxShadow = dropShadow(effect);
            } else if (effect.type === 'INNER_SHADOW') {
              styles.boxShadow = innerShadow(effect);
            } else if (effect.type === 'LAYER_BLUR') {
              styles.filter = `blur(${effect.radius}px)`;
            }
          }
        }

        const lastStroke = getPaint(node.strokes);
        if (lastStroke) {
          if (lastStroke.type === 'SOLID') {
            const weight = node.strokeWeight || 1;
            styles.border = `${weight}px solid ${colorString(lastStroke.color)}`;
          }
        }

        const cornerRadii = node.rectangleCornerRadii;
        if (cornerRadii && cornerRadii.length === 4 && cornerRadii[0] + cornerRadii[1] + cornerRadii[2] + cornerRadii[3] > 0) {
          styles.borderRadius = `${cornerRadii[0]}px ${cornerRadii[1]}px ${cornerRadii[2]}px ${cornerRadii[3]}px`;
        }
      }
    } else if (node.type === 'TEXT') {
      const lastFill = getPaint(node.fills);
      if (lastFill) {
        styles.color = colorString(lastFill.color);
      }

      const lastStroke = getPaint(node.strokes);
      if (lastStroke) {
        const weight = node.strokeWeight || 1;
        styles.WebkitTextStroke = `${weight}px ${colorString(lastStroke.color)}`;
      }

      const fontStyle = node.style;

      const applyFontStyle = (_styles, fontStyle) => {
        if (fontStyle) {
          _styles.fontSize = fontStyle.fontSize;
          _styles.fontWeight = fontStyle.fontWeight;
          _styles.fontFamily = fontStyle.fontFamily;
          _styles.textAlign = fontStyle.textAlignHorizontal;
          _styles.fontStyle = fontStyle.italic ? 'italic' : 'normal';
          _styles.lineHeight = `${fontStyle.lineHeightPercent * 1.25}%`;
          _styles.letterSpacing = `${fontStyle.letterSpacing}px`;
        }
      }
      applyFontStyle(styles, fontStyle);

      if (node.name.substring(0, 6) === 'input:') {
        content = [`<input key="${node.id}" type="text" placeholder="${node.characters}" name="${node.name.substring(7)}" />`];
      } else if (node.characterStyleOverrides) {
        let para = '';
        const ps = [];
        const styleCache = {};
        let currStyle = 0;

        const commitParagraph = (key) => {
          if (para !== '') {
            if (styleCache[currStyle] == null && currStyle !== 0) {
              styleCache[currStyle] = {};
              applyFontStyle(styleCache[currStyle], node.styleOverrideTable[currStyle]);
            }

            const styleOverride = styleCache[currStyle] ? JSON.stringify(styleCache[currStyle]) : '{}';

            ps.push(`<span style={${styleOverride}} key="${key}">${para}</span>`);
            para = '';
          }
        }

        for (const i in node.characters) {
          let idx = node.characterStyleOverrides[i];

          if (node.characters[i] === '\n') {
            commitParagraph(i);
            ps.push(`<br key="${`br${i}`}" />`);
            continue;
          }

          if (idx == null) idx = 0;
          if (idx !== currStyle) {
            commitParagraph(i);
            currStyle = idx;
          }

          para += node.characters[i];
        }
        commitParagraph('end');

        content = ps;
      } else {
        content = node.characters.split("\n").map((line, idx) => `<div key="${idx}">${line}</div>`);
      }
    }

    function printDiv(styles, outerStyle, indent) {
      print(`<div style={${JSON.stringify(outerStyle)}} className="${outerClass}">`, indent);
      print(`  <div`, indent);
      print(`    id="${node.id}"`, indent);
      print(`    style={${JSON.stringify(styles)}}`, indent);
      print(`    className="${innerClass}"`, indent);
      print(`  >`, indent);
    }
    if (parent != null) {
      printDiv(styles, outerStyle, indent);
    }

    if (node.id !== component.id && node.name.charAt(0) === '#') {
      // print(`    <${node.name.replace(/\W+/g, '')} {...this.props} nodeId="${node.id}" />`, indent);
      print(`    <${node.name.replace(/\W+/g, '')} />`, indent);
      createComponent(node, imgMap, componentMap);
    } else if (node.type === 'VECTOR') {
      print(`    <div className="vector" dangerouslySetInnerHTML={{__html: \`${imgMap[node.id]}\`}} />`, indent);
    } else {
      const newNodeBounds = node.absoluteBoundingBox;
      const newLastVertical = newNodeBounds && newNodeBounds.y + newNodeBounds.height;
      print(`    <div>`, indent);
      let first = true;
      for (const child of minChildren) {
        visitNode(child, node, first ? null : newLastVertical, indent + '      ');
        first = false;
      }
      for (const child of centerChildren) visitNode(child, node, null, indent + '      ');
      if (maxChildren.length > 0) {
        outerClass += ' maxer';
        styles.width = '100%';
        styles.pointerEvents = 'none';
        styles.backgroundColor = null;
        printDiv(styles, outerStyle, indent + '      ');
        first = true;
        for (const child of maxChildren) {
          visitNode(child, node, first ? null : newLastVertical, indent + '          ');
          first = false;
        }
        print(`        </div>`, indent);
        print(`      </div>`, indent);
      }
      if (content != null) {
        if (node.name.charAt(0) === '$') {
          const varName = node.name.substring(1);
          print(`      {this.props.${varName} && this.props.${varName}.split("\\n").map((line, idx) => <div key={idx}>{line}</div>)}`, indent);
          print(`      {!this.props.${varName} && (<div>`, indent);
          for (const piece of content) {
            print(piece, indent + '        ');
          }
          print(`      </div>)}`, indent);
        } else {
          for (const piece of content) {
            print(piece, indent + '      ');
          }
        }
      }
      print(`    </div>`, indent);
    }

    if (parent != null) {
      print(`  </div>`, indent);
      print(`</div>`, indent);
    }
  }

  visitNode(component, null, null, '  ');
  print('    );', '');
  print('  }', '');
  print('}', '');
  componentMap[component.id] = {instance, name, doc};
}

module.exports = {createComponent, colorString}


main().catch((err) => {
  console.error(err);
  console.error(err.stack);
});
