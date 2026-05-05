<script lang="ts">
	import { Button } from "$lib/components/ui/button/index.js";
</script>

<svelte:head>
	<title>tietiezhi WebUI</title>
</svelte:head>

<section class="min-h-screen bg-background text-foreground">
	<div class="mx-auto flex min-h-screen max-w-5xl flex-col justify-center gap-8 px-6 py-16">
		<div class="space-y-4">
			<p class="text-sm uppercase tracking-[0.18em] text-muted-foreground">tietiezhi</p>
			<h1 class="max-w-3xl text-4xl font-semibold tracking-tight sm:text-5xl">
				SvelteKit + Tailwind CSS + shadcn-svelte WebUI
			</h1>
			<p class="max-w-2xl text-base leading-7 text-muted-foreground sm:text-lg">
				当前前端项目已按官方文档使用 pnpm 初始化完成，并接入了第一个 shadcn-svelte 组件。
			</p>
		</div>

		<div class="flex flex-wrap gap-3">
			<Button>Open WebUI</Button>
			<Button variant="outline" href="https://www.shadcn-svelte.com/docs/installation/sveltekit">
				Installation Docs
			</Button>
		</div>
	</div>
</section>
