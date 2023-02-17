import { render } from 'ejs';
import fs, { cpSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'fs';
import path, { basename, isAbsolute, join } from 'path';
import { argv, cwd, exit, stderr } from 'process';
import Showdown from 'showdown';
import yaml from 'yaml';

if (argv.length < 3) {
  stderr.write('Missing path to directory!\n');
  exit(1);
}

const rootDirPath = // Convert the path to an absolute path if necessary
  isAbsolute(argv[2]) ? argv[2] : join(cwd(), argv[2]);

if (!existsSync(rootDirPath)) {
  stderr.write(`Directory doesn't exist: ${rootDirPath}\n`);
  exit(1);
}

const RenderOptions = {
  root: rootDirPath
};

const MarkdownConverter = new Showdown.Converter({
  backslashEscapesHTMLTags: true,
  completeHTMLDocument: false,
  customizedHeaderId: false,
  disableForced4SpacesIndentedSublists: false,
  ellipsis: true,
  emoji: true,
  encodeEmails: true,
  extensions: undefined,
  ghCodeBlocks: true,
  ghCompatibleHeaderId: true,
  ghMentions: true,
  ghMentionsLink: true,
  headerLevelStart: 1,
  literalMidWordUnderscores: true,
  metadata: true,
  noHeaderId: false,
  omitExtraWLInCodeBlocks: true,
  openLinksInNewWindow: false,
  parseImgDimensions: true,
  prefixHeaderId: false,
  rawHeaderId: false,
  rawPrefixHeaderId: false,
  requireSpaceBeforeHeadingText: true,
  simpleLineBreaks: true,
  simplifiedAutoLink: true,
  smartIndentationFix: false,
  smoothLivePreview: false,
  splitAdjacentBlockquotes: true,
  strikethrough: true,
  tables: true,
  tablesHeaderId: true,
  tasklists: true,
  underline: true,
});

const CustomSyntax = [{
  // Pretty 2-column layout for questions and answers
  // Regex explained: Match a single th-td pattern, and expect it to possibly repeat
  regex: /^\^TH\s*(.+?)\s*^\^TD\s*(.+?)\s*(?=\n{2}|^\^TH|^\^TD|\n$)(?:^\^TH\s*(.+?)\s*^\^TD\s*(.+?)\s*(?=\n{2}|^\^TH|^\^TD|\n$))*/gms,
  handle: (s = '', m) => {
    let i = 1;
    let r = '<table>\n';
    while (m[i]) {
      if (i % 2) {
        r += `<tr>\n<th>\n${m[i]}\n</th>\n`;
      } else {
        r += `<td>\n${m[i]}</td>\n</tr>\n`;
      }
      i += 1;
    }
    r += '</table>\n';
    return s.substring(0, m.index) + r + s.substring(m.index + m[0].length);
  },
}];

const TemplateUtils = (() => {

  /**
   * @param {string} relativeDirPath
   */
  function index(relativeDirPath) {
    const result = [];
    const dirPath = join(rootDirPath, relativeDirPath);
    for (const fileName of readdirSync(dirPath, { encoding: 'utf-8' })) {
      const s = statSync(join(dirPath, fileName));
      result.push({
        name: fileName,
        type: s.isFile() ? 'file' : 'dir',
        size: s.size,
        created: s.ctime,
        modified: s.mtime,
        title: fileName.replace('_', ' ').replace(/(\b[a-z](?!\s))/g, x => x.toUpperCase()).replace(/\.\w+$/g, ''),
      });
    }
    return result;
  }

  return {
    index,
    modules: {
      fs,
      path,
    }
  };

})();

const processedDirs = processDir(rootDirPath);
writeOut(processedDirs);
exit(0);

/**
 * Processes a directory.
 * @param {string} dirPath
 * @param {string} layout
 * @param {object} config
 */
function processDir(dirPath, layout = null, config = {}) {

  const result = {
    // TODO: 'dist' is the hard coded root output directory name.
    // The user should be able to provide this into the script as an argument.
    name: dirPath === rootDirPath ? 'dist' : basename(dirPath),
    files: [],
    dirs: [],
    assets: [],
  };

  const configPath = join(dirPath, '+config.yaml');
  const layoutPath = join(dirPath, '+layout.ejs');
  const layoutNewPath = join(dirPath, '+layout.new.ejs');

  if (existsSync(configPath)) {
    const text = readFileSync(configPath, { encoding: 'utf-8' });
    config = { ...config, ...yaml.parse(text) };
  }

  /** @type {string} */
  let childLayout = null;

  if (existsSync(layoutPath)) {
    childLayout = readFileSync(layoutPath, { encoding: 'utf-8' });
  }

  if (existsSync(layoutNewPath)) {
    layout = readFileSync(layoutNewPath, { encoding: 'utf-8' });
  }

  if (layout && childLayout) {
    layout = layout.replace(/\<\%\s*\$child\s*\%\>/gm, childLayout);
  } else if (!layout) {
    layout = childLayout || '<%- $child %>';
  }

  for (const file of readdirSync(dirPath, { encoding: 'utf-8', withFileTypes: true })) {

    if (file.name.startsWith('+'))
      continue;

    const absolutePath = join(dirPath, file.name);

    if (file.isFile()) {

      if (file.name.match(/\.md$/gm)) {
        const text = readFileSync(absolutePath, { encoding: 'utf-8' });
        const preprocessed = preProcessMarkdown(text);
        const html = MarkdownConverter.makeHtml(preprocessed);
        const meta = MarkdownConverter.getMetadata();
        const data = { ...config, ...meta, $util: TemplateUtils };
        const rendered = render(layout, { $child: render(html, data, RenderOptions), ...data }, RenderOptions);
        const postProcessed = postProcessHtml(rendered);
        result.files.push({
          name: file.name.replace(/\.md$/g, '.html'),
          text: postProcessed,
        });
      }

      else {
        result.assets.push({
          name: file.name,
          source: absolutePath,
        });
      }

    }

    else if (file.isDirectory()) {
      result.dirs.push(processDir(absolutePath, layout, config));
    }

    else {
      stderr.write(`Invalid file type in ${dirPath}: ${file.name}\n`);
    }

  }

  return result;
}

/**
 * Preprocess a markdown file.
 * @param {string} text
 */
function preProcessMarkdown(text) {
  text = convertLocalLinks(text);
  text = convertCustomSyntax(text);
  return text;
}

/**
 * Converts local links to MD files to HTML files.
 * @param {string} text
 */
function convertLocalLinks(text) {
  return text.replace(/\[(.+?)\]\((\..+?)\.md\)/gm, '[$1]($2.html)');
}

/**
 * Convert custom syntax to HTML
 * @param {string} unprocessedPageText
 */
function convertCustomSyntax(unprocessedPageText) {
  let out = unprocessedPageText;
  for (const syntax of CustomSyntax) {
    if (syntax.subst) {
      out = out.replace(syntax.regex, syntax.subst);
    }
    if (syntax.handle) {
      let m;
      while (m = syntax.regex.exec(out)) {
        out = syntax.handle(out, m);
      }
    }
  }
  return out;
}

/**
 * Post-process the rendered HTML.
 * @param {string} text
 */
function postProcessHtml(text) {
  text = text.replace(/<a\s*(.*?)\s*href="(\/.+?)\.md"\s*(.*?)\s*>/gm, '<a $1 href="$2.html" $3>');
  return text;
}

/**
 * Writes the processed files to a directory.
 * @param {{name: string, files: {name: string, text: string}[], dirs: []: assets: []}} out
 * @param {string} parentDirName
 */
function writeOut(out, parentDirPath = '') {

  const dirPath = parentDirPath ? join(parentDirPath, out.name) : out.name;

  if (existsSync(dirPath)) {
    rmSync(dirPath, { force: true, recursive: true });
  }

  mkdirSync(dirPath);
  stderr.write(`D   ${dirPath}\n`);

  for (const file of out.files) {
    const filePath = join(dirPath, file.name);
    writeFileSync(filePath, file.text, { encoding: 'utf-8' });
    stderr.write(`P   ${filePath}\n`);
  }

  for (const asset of out.assets) {
    const filePath = join(dirPath, asset.name);
    cpSync(asset.source, filePath);
    stderr.write(`A   ${filePath}\n`);
  }

  for (const dir of out.dirs) {
    writeOut(dir, dirPath);
  }

}