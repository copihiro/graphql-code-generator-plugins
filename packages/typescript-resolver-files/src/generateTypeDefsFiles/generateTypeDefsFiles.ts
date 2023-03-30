import * as path from 'path';
import { StandardFile } from '../generateResolverFiles';
import type { ParseSourcesResult } from '../parseSources';
import { isWhitelistedModule } from '../utils';
import { TypeDefsFileMode } from '../validatePresetConfig';
import { generateTypeDefsContent } from './generateTypeDefsContent';

interface GenerateTypeDefsFilesParams {
  baseOutputDir: string;
  typeDefsFilePath: string;
  typeDefsFileMode: TypeDefsFileMode;
  sourceMap: ParseSourcesResult['sourceMap'];
  whitelistedModules: string[];
  blacklistedModules: string[];
}

export const generateTypeDefsFiles = ({
  baseOutputDir,
  typeDefsFilePath,
  typeDefsFileMode,
  sourceMap,
  blacklistedModules,
  whitelistedModules,
}: GenerateTypeDefsFilesParams): Record<string, StandardFile> => {
  const filesContent: Record<string, string> = {};
  Object.values(sourceMap).forEach(({ moduleName, source, sourcePath }) => {
    const isWhitelisted = isWhitelistedModule({
      moduleName,
      whitelistedModules,
      blacklistedModules,
    });

    if (typeDefsFileMode === 'merged') {
      appendSDLToFile({
        filesContent,
        filePath: path.posix.join(baseOutputDir, typeDefsFilePath),
        rawSDL: source.rawSDL,
      });
      return;
    }

    if (isWhitelisted && typeDefsFileMode === 'mergedWhitelisted') {
      appendSDLToFile({
        filesContent,
        filePath: path.posix.join(baseOutputDir, typeDefsFilePath),
        rawSDL: source.rawSDL,
      });
      return;
    }

    if (isWhitelisted && typeDefsFileMode === 'modules') {
      appendSDLToFile({
        filesContent,
        filePath: path.posix.join(sourcePath.dir, typeDefsFilePath),
        rawSDL: source.rawSDL,
      });
      return;
    }
  });

  const result: Record<string, StandardFile> = {};
  Object.entries(filesContent).forEach(([filePath, content]) => {
    result[filePath] = {
      __filetype: 'file',
      content: generateTypeDefsContent({ mergedSDL: content }),
      mainImportIdentifier: 'typeDefs',
    };
  });

  return result;
};

const appendSDLToFile = ({
  rawSDL,
  filePath,
  filesContent,
}: {
  rawSDL: string | undefined;
  filePath: string;
  filesContent: Record<string, string>;
}): void => {
  if (!rawSDL) {
    return;
  }

  if (!filesContent[filePath]) {
    filesContent[filePath] = '';
  }
  filesContent[filePath] += `${rawSDL}\n`;
};