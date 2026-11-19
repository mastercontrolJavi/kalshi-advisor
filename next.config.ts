import type {NextConfig} from 'next';
// NEXT_DIST_DIR lets a verification build live beside the running production build without overwriting it.
// No persistent webpack cache for production builds: with Next 15.5 / Node 24 here, any source change followed by a build
// over the existing .next/cache/webpack crashes in WasmHash._updateWithBuffer ("reading 'length'"), so the launch after nearly
// every code change failed to boot (2026-11-17, reproduced: clean build OK, rebuild unchanged OK, edit + rebuild fails).
// A clean build takes ~30 s. Dev builds keep their cache.
const config:NextConfig={reactStrictMode:true,poweredByHeader:false,outputFileTracingRoot:process.cwd(),experimental:{cpus:2},distDir:process.env.NEXT_DIST_DIR??'.next',
  webpack:(webpackConfig,{dev})=>{if(!dev)webpackConfig.cache=false;return webpackConfig;}};
export default config;
