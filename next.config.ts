import type {NextConfig} from 'next';
// NEXT_DIST_DIR lets a verification build live beside the running production build without overwriting it.
const config:NextConfig={reactStrictMode:true,poweredByHeader:false,outputFileTracingRoot:process.cwd(),experimental:{cpus:2},distDir:process.env.NEXT_DIST_DIR??'.next'};
export default config;
