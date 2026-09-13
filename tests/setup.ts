if (typeof HTMLDialogElement !== "undefined") {
	HTMLDialogElement.prototype.showModal ??= function showModal() {
		this.setAttribute("open", "");
	};
	HTMLDialogElement.prototype.close ??= function close() {
		this.removeAttribute("open");
	};
}
if (typeof EventSource === "undefined") {
	globalThis.EventSource = class {
		url: string;
		constructor(url: string) {
			this.url = url;
		}
		addEventListener() {}
		close() {}
	} as unknown as typeof EventSource;
}
