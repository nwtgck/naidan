import fs from 'node:fs/promises'
import path from 'node:path'
import type { Plugin, ResolvedConfig } from 'vite'

/**
 * Removes selected files after Vite has copied publicDir into the build output.
 *
 * Vite copies all public files for every build mode. The standalone package is
 * opened from file:// and cannot be crawled as a website, so robots.txt has no
 * purpose there. Removing only the selected output file preserves other public
 * assets such as the favicon and keeps the hosted build unchanged.
 *
 * This plugin must appear before packaging plugins that read the completed
 * output directory from closeBundle so omitted files are not included in ZIPs.
 */
export function omitBuildOutputFilesPlugin({ fileNames }: {
  fileNames: readonly string[]
}): Plugin {
  let resolvedConfig: ResolvedConfig | undefined

  return {
    name: 'omit-build-output-files',
    apply: 'build',
    configResolved(config) {
      resolvedConfig = config
    },
    async closeBundle() {
      if (resolvedConfig === undefined) {
        throw new Error('Vite config was not resolved before omitting build output files.')
      }
      const outputDirectory = path.resolve(
        resolvedConfig.root,
        resolvedConfig.build.outDir,
      )
      await Promise.all(fileNames.map(async (fileName) => {
        const outputPath = path.resolve(outputDirectory, fileName)
        const relativeOutputPath = path.relative(outputDirectory, outputPath)
        if (
          relativeOutputPath.startsWith(`..${path.sep}`)
          || relativeOutputPath === '..'
          || path.isAbsolute(relativeOutputPath)
        ) {
          throw new Error(`Cannot omit a file outside the build output: ${fileName}`)
        }
        await fs.rm(outputPath, { force: true })
      }))
    },
  }
}
