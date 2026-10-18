// Live jev engine checks against a local Chrome and a local fixture page.
// Gated by PI_CU_LIVE=1 because it starts a browser process. No model calls.
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createServer } from "node:http";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { listCdpPageContexts, openCdpTabForContext } from "../src/cdp.ts";
import { executeJevAction, jevFreshForAction, jevFreshMarker, observeJevPage, settleAfterJevInput, JevStalePage } from "../src/jev/driver.ts";

const HTML = `<!doctype html><title>Guard checks</title>
<style>body{margin:30px}button{width:180px;height:50px}#outside{position:absolute;top:3000px}</style>
<p id="context">Cart total: $10</p>
<form id="buyform">
  <p id="price">Total $10</p>
  <button type="button" id="target" onclick="window.clicks=(window.clicks||0)+1">Continue</button>
  <label>City<input id="field" value="Zurich"></label>
  <label><input id="toggle" type="checkbox">Refundable</label>
  <select aria-label="Category"><option>All</option><option>Design</option></select>
</form>
<aside id="unrelated">News</aside>
<p id="outside">Unrelated offscreen text</p>`;

function freePort() {
	return new Promise((resolve, reject) => {
		const server = net.createServer();
		server.on("error", reject);
		server.listen(0, "127.0.0.1", () => {
			const port = server.address().port;
			server.close(() => resolve(port));
		});
	});
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/** Prefer an explicit override, then common Chromium-family install locations. */
function resolveBrowserExecutable() {
	const override = process.env.PI_COMPUTER_USE_CHROME_EXECUTABLE?.trim();
	if (override) return existsSync(override) ? override : null;
	const candidates = process.platform === "darwin"
		? [
			"/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
			"/Applications/Chromium.app/Contents/MacOS/Chromium",
			"/Applications/Helium.app/Contents/MacOS/Helium",
		]
		: process.platform === "win32"
			? [
				process.env.LOCALAPPDATA && path.join(process.env.LOCALAPPDATA, "Google", "Chrome", "Application", "chrome.exe"),
				process.env.PROGRAMFILES && path.join(process.env.PROGRAMFILES, "Google", "Chrome", "Application", "chrome.exe"),
			]
			: ["/usr/bin/google-chrome", "/usr/bin/google-chrome-stable", "/usr/bin/chromium", "/usr/bin/chromium-browser"];
	return candidates.filter(Boolean).find((candidate) => existsSync(candidate)) ?? null;
}

async function waitForCdp(port, timeoutMs = 15_000) {
	const deadline = Date.now() + timeoutMs;
	while (Date.now() < deadline) {
		try {
			const response = await fetch(`http://127.0.0.1:${port}/json/list`, { signal: AbortSignal.timeout(1_000) });
			const targets = await response.json();
			if (targets.some((target) => target.type === "page" && target.webSocketDebuggerUrl)) return;
		} catch {
			// still starting
		}
		await sleep(100);
	}
	throw new Error(`Chrome did not expose CDP on ${port}`);
}

const RESET = `(() => {
  const target = document.querySelector('#target');
  target.style.display = 'block';
  target.disabled = false;
  target.removeAttribute('aria-label');
  document.querySelector('#field').readOnly = false;
  document.querySelector('#field').value = 'Zurich';
  document.querySelector('#toggle').checked = false;
  document.querySelector('#context').textContent = 'Cart total: $10';
  document.querySelector('#price').textContent = 'Total $10';
  document.querySelector('#unrelated').textContent = 'News';
  document.querySelector('#outside').textContent = 'Unrelated offscreen text';
})()`;

async function main() {
	const executable = resolveBrowserExecutable();
	if (!executable) {
		console.log("SKIP live jev checks: no Chromium-family browser found. Set PI_COMPUTER_USE_CHROME_EXECUTABLE to an executable path.");
		return;
	}
	const httpPort = await freePort();
	const server = createServer((_request, response) => {
		response.writeHead(200, { "content-type": "text/html; charset=utf-8" });
		response.end(HTML);
	});
	await new Promise((resolve) => server.listen(httpPort, "127.0.0.1", resolve));

	const cdpPort = await freePort();
	const profile = mkdtempSync(path.join(os.tmpdir(), "pi-jevu-live-"));
	const chrome = spawn(executable, [
		"--headless=new",
		`--remote-debugging-port=${cdpPort}`,
		`--user-data-dir=${profile}`,
		"--no-first-run",
		"--no-default-browser-check",
		"--window-size=1120,780",
		`http://127.0.0.1:${httpPort}/fixture.html`,
	], { stdio: "ignore" });

	const previousPort = process.env.PI_COMPUTER_USE_CDP_PORT;
	process.env.PI_COMPUTER_USE_CDP_PORT = String(cdpPort);
	const passed = [];
	try {
		await waitForCdp(cdpPort);
		const pages = await listCdpPageContexts();
		const page = pages.find((candidate) => candidate.url.includes("fixture.html")) ?? pages[0];
		assert.ok(page, "fixture page must be discoverable over CDP");
		const tab = await openCdpTabForContext(page.contextId);
		assert.ok(tab, "a CDP tab must open for the fixture page");
		try {
			const context = { contextId: page.contextId, targetId: page.targetId };
			const observe = () => observeJevPage(tab, context);
			let observation = await observe();
			const target = () => observation.page.actions.find((action) => action.role === "button" && action.kind === "click");
			assert.ok(target(), "the Continue button must be observed");

			// Movement changes geometry, not meaning: fresh geometry is resolved at input time.
			await tab.evaluate("document.querySelector('#target').style.transform='translateX(200px)'");
			assert.equal(await jevFreshMarker(tab, observation.page), true, "movement must not invalidate the marker");
			assert.equal(await jevFreshForAction(tab, observation.page, target()), true, "movement must not invalidate the click guard");
			await executeJevAction(tab, target());
			assert.equal(await tab.evaluate("window.clicks"), 1, "a moving target must be clicked at its current location");
			passed.push("moving target clicked at its current location");

			// Marker invalidations: visible meaning or identity changed.
			const markerInvalidations = {
				"visible context": "document.querySelector('#context').textContent='Cart total: $100'",
				"accessible label": "document.querySelector('#target').setAttribute('aria-label','Delete account')",
				"field property": "document.querySelector('#field').value='London'",
				"checkbox property": "document.querySelector('#toggle').checked=true",
				"disabled target": "document.querySelector('#target').disabled=true",
				"hidden target": "document.querySelector('#target').style.display='none'",
				"replaced node": "document.querySelector('#target').outerHTML=document.querySelector('#target').outerHTML",
			};
			for (const [label, expression] of Object.entries(markerInvalidations)) {
				await tab.evaluate(RESET);
				observation = await observe();
				await tab.evaluate(expression);
				assert.equal(await jevFreshMarker(tab, observation.page), false, `${label} must invalidate the marker`);
				passed.push(`${label} invalidates the marker`);
			}

			// Offscreen text is not visible meaning.
			await tab.evaluate(RESET);
			observation = await observe();
			await tab.evaluate("document.querySelector('#outside').textContent='Updated outside the viewport'");
			assert.equal(await jevFreshMarker(tab, observation.page), true, "unrelated offscreen text must not invalidate the marker");
			passed.push("unrelated offscreen text does not invalidate");

			// Scoped click guards: content outside the target's scope may change.
			await tab.evaluate(RESET);
			observation = await observe();
			await tab.evaluate("document.querySelector('#unrelated').textContent='New unrelated news'");
			assert.equal(await jevFreshForAction(tab, observation.page, target()), true, "visible content outside the target scope must not invalidate the click guard");
			passed.push("click guard accepts unrelated visible updates");

			const guardInvalidations = {
				"nearby price": "document.querySelector('#price').textContent='Total $100'",
				"form value": "document.querySelector('#field').value='changed'",
				"form toggle": "document.querySelector('#toggle').checked=true",
				"target replacement": "document.querySelector('#target').outerHTML=document.querySelector('#target').outerHTML",
			};
			for (const [label, expression] of Object.entries(guardInvalidations)) {
				await tab.evaluate(RESET);
				observation = await observe();
				await tab.evaluate(expression);
				assert.equal(await jevFreshForAction(tab, observation.page, target()), false, `${label} must invalidate the click guard`);
				passed.push(`${label} invalidates the click guard`);
			}

			// A textless overlay changes no semantics but must block the click.
			await tab.evaluate(RESET);
			observation = await observe();
			const covered = target();
			await tab.evaluate("const cover=document.createElement('div'); cover.style.cssText='position:fixed;inset:0;z-index:9999;background:white'; document.body.append(cover)");
			assert.equal(await jevFreshForAction(tab, observation.page, covered), true, "an overlay must not alter semantic freshness");
			await assert.rejects(executeJevAction(tab, covered), /covered|not confirmed/i, "a covered target must not be clicked");
			assert.equal(await tab.evaluate("window.clicks"), 1, "the covered click must not be delivered");
			await tab.evaluate("document.querySelector('div[style*=\"inset\"]')?.remove()");
			passed.push("overlay blocked before input");

			// Native select carries an observed option value.
			observation = await observe();
			const select = observation.page.actions.find((action) => action.kind === "select");
			assert.ok(select, "a native select must expose its options");
			await executeJevAction(tab, select);
			assert.equal(await tab.evaluate("document.querySelector('select').value"), select.value, "native dropdown must select the observed option");
			passed.push("native dropdown selects an observed option");

			// Wheel input lands at the viewport center and actually scrolls the page.
			await tab.evaluate("window.scrollTo(0, 0)");
			observation = await observe();
			const scrollDown = observation.page.actions.find((action) => action.id === "scroll_down");
			assert.ok(scrollDown, "a scrollable page must expose scroll_down");
			await executeJevAction(tab, scrollDown);
			let scrolled = 0;
			for (let attempt = 0; attempt < 20 && scrolled === 0; attempt += 1) {
				await sleep(50);
				scrolled = Number(await tab.evaluate("window.scrollY")) || 0;
			}
			assert.ok(scrolled > 0, "scroll_down must move the page from the viewport center");
			await tab.evaluate("window.scrollTo(0, 0)");
			passed.push("scroll_down moves the page from the viewport center");

			// Typing replaces the value and waits for asynchronous combobox suggestions.
			await tab.evaluate("const field=document.querySelector('#field'); field.setAttribute('role','combobox'); field.setAttribute('aria-controls','suggestions'); field.insertAdjacentHTML('afterend','<div role=listbox id=suggestions></div>'); field.addEventListener('input',()=>setTimeout(()=>{document.querySelector('#suggestions').innerHTML='<div role=option>Generated</div>'},60))");
			observation = await observe();
			const fill = observation.page.actions.find((action) => action.kind === "fill");
			assert.ok(fill, "an editable field must expose TYPE_TEXT");
			await executeJevAction(tab, fill, "Generated");
			await settleAfterJevInput(tab, fill);
			assert.equal(await tab.evaluate("document.querySelector('#field').value"), "Generated", "typing must replace the field value");
			observation = await observe();
			assert.ok(observation.page.actions.some((action) => action.role === "option"), "asynchronous suggestions must be observed after typing");
			passed.push("real text input replaces the value and waits for suggestions");

			// Navigation invalidates the previous document.
			assert.equal(await jevFreshMarker(tab, observation.page), true, "the successor page must be fresh for its own decision");
			await tab.navigate(`http://127.0.0.1:${httpPort}/fixture.html?second=1`);
			assert.equal(await jevFreshMarker(tab, observation.page), false, "navigation must invalidate the old document");
			passed.push("navigation invalidates the old document");
		} finally {
			tab.close();
		}
	} finally {
		chrome.kill("SIGTERM");
		server.close();
		await Promise.race([
			new Promise((resolve) => chrome.once("exit", resolve)),
			sleep(3_000),
		]);
		try {
			rmSync(profile, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
		} catch {
			// A terminating browser may still hold profile files; the OS temp dir is disposable.
		}
		if (previousPort === undefined) delete process.env.PI_COMPUTER_USE_CDP_PORT;
		else process.env.PI_COMPUTER_USE_CDP_PORT = previousPort;
	}
	console.log(passed.join("\n"));
	console.log(`PASS: ${passed.length} live jev browser checks; no model calls`);
}

if (process.env.PI_CU_LIVE !== "1") {
	console.log("SKIP live jev checks (set PI_CU_LIVE=1)");
} else {
	await main();
}
