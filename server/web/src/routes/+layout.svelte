<script lang="ts">
	import '$lib/styles/index.css';
	import AppShell from '$lib/layout/app-shell/index.svelte';
	import favicon from '$lib/assets/favicon.png';

	let { children } = $props();
</script>

<svelte:head><link rel="icon" href={favicon} /></svelte:head>
<AppShell>
	{@render children()}
</AppShell>
