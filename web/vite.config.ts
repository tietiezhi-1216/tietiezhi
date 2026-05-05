import tailwindcss from '@tailwindcss/vite';
import { sveltekit } from '@sveltejs/kit/vite';
import { defineConfig } from 'vite';

const apiTarget = process.env.TIETIEZHI_API_URL ?? 'http://127.0.0.1:18178';

export default defineConfig({
	plugins: [tailwindcss(), sveltekit()],
	server: {
		proxy: {
			'/health': apiTarget,
			'/v1': apiTarget
		}
	}
});
