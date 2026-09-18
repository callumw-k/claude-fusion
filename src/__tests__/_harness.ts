export function test(name: string, fn: () => void | Promise<void>) {
	try {
		Promise.resolve(fn()).then(
			() => console.log(`✓ ${name}`),
			(err) => {
				console.error(`✗ ${name}:`, err);
				process.exitCode = 1;
			},
		);
	} catch (err) {
		console.error(`✗ ${name}:`, err);
		process.exitCode = 1;
	}
}

export function eq<T>(a: T, b: T, msg: string) {
	if (JSON.stringify(a) !== JSON.stringify(b)) {
		throw new Error(`${msg}: got ${JSON.stringify(a)}, want ${JSON.stringify(b)}`);
	}
}
