/**
 * Astro 框架配置文件
 * 
 * 本文件是 Astro 静态网站生成器的核心配置文件
 * 用于定义站点的基本设置、构建选项和输出模式
 */

// 引入 Astro 的 defineConfig 工具函数，用于定义配置
import { defineConfig } from 'astro/config';

// 使用 defineConfig 导出站点配置
export default defineConfig({
  // site: 站点的完整 URL，用于 SEO 和生成绝对链接
  // 当页面需要分享到社交媒体时，Astro 会用这个 URL 生成完整的页面地址
  site: 'https://fanren.tech',
  
  // build: 构建相关的配置选项
  build: {
    // outDir: 指定构建输出的目录名称
    // Astro 构建完成后，会将生成的静态文件放到这个目录中
    outDir: 'dist'
  },
  
  // output: 站点的输出模式
  // 'static' 表示生成纯静态网站，所有页面在构建时预渲染为 HTML
  // 这种模式适合内容不经常变化的博客网站，无需服务器端渲染
  output: 'static',
});
