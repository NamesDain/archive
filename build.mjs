import { createHash } from "crypto";
import { copyFile, mkdir, readdir, readFile, writeFile } from "fs/promises";
import { extname } from "path";

import commonjs from "@rollup/plugin-commonjs";
import nodeResolve from "@rollup/plugin-node-resolve";
import swc from "@swc/core";
import { rollup } from "rollup";
import esbuild from "rollup-plugin-esbuild";

// Kettu evaluates a plugin as `vendetta => { return <bundle> }`, so the bundle has
// to be a single expression that yields the plugin object. That is exactly what a
// rollup IIFE build produces, which is why this mirrors the upstream Vendetta
// plugin template rather than using esbuild's bundler directly.

const extensions = [".js", ".jsx", ".mjs", ".ts", ".tsx", ".cts", ".mts"];

/** @type import("rollup").InputPluginOption */
const plugins = [
    nodeResolve(),
    commonjs(),
    {
        name: "swc",
        async transform(code, id) {
            const ext = extname(id);
            if (!extensions.includes(ext)) return null;

            const ts = ext.includes("ts");
            const tsx = ts ? ext.endsWith("x") : undefined;
            const jsx = !ts ? ext.endsWith("x") : undefined;

            const result = await swc.transform(code, {
                filename: id,
                jsc: {
                    externalHelpers: true,
                    parser: {
                        syntax: ts ? "typescript" : "ecmascript",
                        tsx,
                        jsx
                    },
                    transform: {
                        react: {
                            // Discord mobile ships the classic runtime; the automatic
                            // one would emit an import of react/jsx-runtime that the
                            // plugin sandbox cannot resolve.
                            runtime: "classic",
                            pragma: "React.createElement",
                            pragmaFrag: "React.Fragment"
                        }
                    }
                },
                env: {
                    targets: "defaults",
                    include: ["transform-classes", "transform-arrow-functions"]
                }
            });
            return result.code;
        }
    },
    esbuild({ minify: true })
];

for (const plug of await readdir("./plugins")) {
    const manifest = JSON.parse(await readFile(`./plugins/${plug}/manifest.json`));
    const outPath = `./dist/${plug}/index.js`;

    try {
        const bundle = await rollup({
            input: `./plugins/${plug}/${manifest.main}`,
            onwarn: () => {},
            plugins
        });

        await bundle.write({
            file: outPath,
            globals(id) {
                // @vendetta/ui/toasts -> vendetta.ui.toasts, which is the object the
                // loader passes in as the wrapper's single argument.
                if (id.startsWith("@vendetta")) return id.substring(1).replace(/\//g, ".");
                const map = {
                    react: "window.React",
                    "react-native": "window.ReactNative"
                };

                return map[id] || null;
            },
            format: "iife",
            compact: true,
            exports: "named"
        });
        await bundle.close();

        // The hash is what tells an installed copy it is out of date, so it has to
        // be over the built output rather than the sources.
        const built = await readFile(outPath);
        manifest.hash = createHash("sha256").update(built).digest("hex");
        manifest.main = "index.js";
        await mkdir(`./dist/${plug}`, { recursive: true });
        await writeFile(`./dist/${plug}/manifest.json`, JSON.stringify(manifest));

        // docs/ is committed and served by GitHub Pages straight from the branch,
        // which needs no Actions runner - the one part of this repo that has never
        // managed to get one. dist/ stays gitignored and is what the tests load.
        // Mirroring here rather than in a separate script keeps the published copy
        // from silently going stale against the sources.
        await mkdir(`./docs/${plug}`, { recursive: true });
        await copyFile(outPath, `./docs/${plug}/index.js`);
        await writeFile(`./docs/${plug}/manifest.json`, JSON.stringify(manifest));

        console.log(`Successfully built ${manifest.name}!`);
    } catch (e) {
        console.error("Failed to build plugin...", e);
        process.exit(1);
    }
}
