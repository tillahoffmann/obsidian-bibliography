import {
	App,
	SuggestModal,
	Plugin,
	PluginSettingTab,
	Setting,
	MarkdownPostProcessorContext,
	MarkdownSectionInformation,
	TFolder,
	TFile
} from 'obsidian';

/**
 * Settings for the bibliography plugin.
 */
interface BibliographyPluginSettings {
	bibliographyFolder: string;
}

/**
 * Default settings for the bibliography plugin.
 */
const DEFAULT_SETTINGS: BibliographyPluginSettings = {
	bibliographyFolder: 'bibliography',
}

/**
 * Lookup to go from doi reference types to bibtex reference types.
 */
const DOI_TYPE_LOOKUP: {[key: string]: string } = {
	'article-journal': 'article',
	'monograph': 'book',
	'report': 'techreport',
}

/**
 * List of fields that should be linked via Obsidian.
 */
const LINKED_FIELDS = ['journal', 'publisher'];

/**
 * Top-level plugin that handles everything bibliography-related.
 */
export default class BibliographyPlugin extends Plugin {
	settings: BibliographyPluginSettings;

	/**
	 * Transform a reference enclosed by carets into a nice format.
	 * @param el HTML element containing the corresponding markdown.
	 * @param ctx Context for processing markdown.
	 */
	async postprocessor(el: HTMLElement, ctx: MarkdownPostProcessorContext) {
		// Skip if no section information is available.
		const sectionInfo: MarkdownSectionInformation = ctx.getSectionInfo(el);
		if (sectionInfo == null) {
			return;
		}

		// Get the corresponding markdown text.
		const lines = sectionInfo.text.split(/\r?\n/);
		let text = lines.slice(sectionInfo.lineStart, sectionInfo.lineEnd + 1).join('\n');

		// Skip if the text doesn't start and end with ^^^.
		if (!text.startsWith('^^^') || !text.endsWith('^^^')) {
			return;
		}
		// Drop the leading and trailing ^^^ from the markdown to process.
		text = text.replace(/^\^{3}\s*/, '').replace(/\s*\^{3}$/, '');

		// Clear the content and add it as code.
		el.innerHTML = '';
		let pre = el.createEl('pre');
		let code = pre.createEl('code');
		code.innerText = text;
	}

	async onload() {
		console.log('loading bibliography plugin...');

		await this.loadSettings();

		this.addSettingTab(new BibliographySettingTab(this.app, this));
		this.registerMarkdownPostProcessor(this.postprocessor.bind(this));
		this.addCommand({
			id: 'add-reference',
			name: 'Add reference',
			checkCallback: (checking: boolean) => {
				let leaf = this.app.workspace.activeLeaf;
				if (leaf) {
					if (!checking) {
						new ReferenceModal(this.app, this).open();
					}
					return true;
				}
				return false;
			}
		});
		this.addCommand({
			id: 'reload-plugin',
			name: 'Reload plugin',
			callback: () => {
				this.unload();
				this.load();
			}
		});

		console.log('loaded bibliography plugin');
	}

	onunload() {
		console.log('unloaded bibliography plugin');
	}

	async loadSettings() {
		this.settings = Object.assign({}, DEFAULT_SETTINGS, await this.loadData());
	}

	async saveSettings() {
		await this.saveData(this.settings);
	}
}


/**
 * Interface for author information.
 */
interface Author {
	first: string,
	last: string,
}


interface Reference {
	type: string,
	title: string,
	authors: Author[],
	year: number,
	doi?: string,
	arxiv?: string,
	[x: string]: any,
}

function formatReference(reference: Reference, link: boolean): string {
	var lines = [
		`@${reference.type}{CITEKEY`,
		`author = { ${reference.authors.map(author => `[[${author.last}, ${author.first}]]`).join(' and ')} }`
	];
	for (let key in reference) {
		// We'll deal with authors separately and the type is in the header.
		if (key == 'authors' || key == 'type') {
			continue;
		}
		// Get the value and link it if necessary.
		var value = reference[key];
		if (link && LINKED_FIELDS.contains(key)) {
			value = `[[${value}]]`;
		}
		lines.push(`${key} = { ${value} }`);
	}
	return `${lines.join(',\n  ')}\n}`;
}


class ReferenceModal extends SuggestModal<Reference> {
	plugin: BibliographyPlugin;
	// The last query for which we have fetched results.
	lastQuery: string = null;
	// The suggestions associated with the last query.
	lastSuggestions: Reference[] = [];

	arxivPattern: RegExp = /^(:?https?:\/\/arxiv\.org\/\w{3}\/)?(:?arXiv:)?(?<identifier>\d{4}\.\d{5})(:?.pdf)?$/i;
	arxivAuthorPattern: RegExp = /^(?<first>.+?)\s+(?<last>[^\s]+)$/;

	doiPattern: RegExp = /^(?:https?:\/\/(?:dx\.)?doi\.org\/)?(?:doi:)?(?<identifier>10\.\d{4}\/.*)/;

	constructor(app: App, plugin: BibliographyPlugin) {
		super(app);
		this.plugin = plugin;
		this.setPlaceholder('Enter a doi or arXiv identifier...');
	}

	/**
	 * @public
	 */
	getSuggestions(query: string): Reference[] {
		// Return suggestions if the query is equal to the last query.
		if (query && query == this.lastQuery) {
			console.log('returning existing suggestions for query "' + query + '"');
			return this.lastSuggestions;
		}
		console.log('fetching suggestions for query "' + query + '"');
		this.emptyStateText = 'Fetching results...';

		// See whether the string matches any of the patterns.
		var arxivMatch = query.match(this.arxivPattern);
		var doiMatch = query.match(this.doiPattern);
		if (arxivMatch) {
			// Get the reference from the arxiv.
			let identifier = arxivMatch.groups.identifier;
			fetch('https://export.arxiv.org/api/query?id_list=' + identifier).then(async (response) => {
				let suggestions: Reference[] = [];
				const parser = new DOMParser();
				const payload = parser.parseFromString(await response.text(), 'text/xml');

				for (let entry of payload.getElementsByTagName('entry')) {
					var authors: Author[] = [];
					for (let author of entry.getElementsByTagName('author')) {
						var authorMatch = author.textContent.trim().match(this.arxivAuthorPattern);
						if (authorMatch) {
							authors.push({
								first: authorMatch.groups.first,
								last: authorMatch.groups.last,
							});
						} else {
							console.log('could not obtain author from ' + author.textContent.trim());
							authors.push(null);
						}
					}

					suggestions.push({
						type: 'article',
						authors: authors,
						year: 2000 + parseInt(identifier.substring(0, 2)),
						title: entry.getElementsByTagName('title')[0].textContent,
						journal: 'arXiv',
						arxiv: identifier,
						pages: identifier,
					});
				}

				this.dispatchSuggestions(query, suggestions);
			});
		} else if (doiMatch) {
			// Get the reference by using a doi.
			let identifier = doiMatch.groups.identifier;
			let requestInit = {
				headers: {
					Accept: 'application/json'
				}
			};
			fetch('https://data.crossref.org/' + identifier, requestInit).then(async (response) => {
				var payload = await response.json();
				var authors: Author[] = [];
				for (let author of payload.author) {
					authors.push({
						first: author.given,
						last: author.family,
					});
				}

				var type = DOI_TYPE_LOOKUP[payload.type];
				var suggestion: Reference = {
					title: payload.title,
					authors: authors,
					type: type,
					year: payload.issued['date-parts'][0][0],
					doi: identifier,
				};
				if (type == 'article') {
					suggestion.journal = payload['container-title'];
					suggestion.volume = payload.volume;
					suggestion.pages = payload.page;
					suggestion.number = payload['journal-issue'].issue;
				} else if (type == 'book') {
					suggestion.publisher = payload.publisher;
				} else if (type == 'techreport') {
					suggestion.institution = payload.institution;
				} else {
					console.log(`unrecognised reference type ${type}`);
				}

				this.dispatchSuggestions(query, [suggestion]);
			});
		}
		else {
			// This doesn't look like an identifier we can resolve.
			this.emptyStateText = 'Pattern not recognised';
		}
		return [];
	}

	dispatchSuggestions(query: string, suggestions: Reference[]) {
		console.log('dispatching input event to update ' + suggestions.length + ' suggestions...');
		this.lastSuggestions = suggestions;
		this.lastQuery = query;
		this.emptyStateText = 'No results found';

		// Send an event that will update the results.
		var event = new Event('input', {
			bubbles: true,
			cancelable: true,
		});
		this.inputEl.dispatchEvent(event);
	}

	/**
	 * Renders a reference in the suggestion modal.
	 * @param value
	 * @param el
	 */
	renderSuggestion(value: Reference, el: HTMLElement): void {
		el.innerText = value.title;
	}

	/**
	 * @public
	 */
	onChooseSuggestion(reference: Reference, evt: MouseEvent | KeyboardEvent): void {
		(async () => {
			// some good examples on files here: https://github.com/pagkly/Zed/blob/cdae75ab4db8d328b7ee4b03ef09bb530ae6f811/.obsidian/plugins/note-folder-autorename/main.js

			let itemPath = reference.title + '.md';
			// Create the folder if necessary.
			let folderPath = this.plugin.settings.bibliographyFolder;
			if (folderPath) {
				const folder = this.app.vault.getAbstractFileByPath(folderPath);
				if (!(folder && folder instanceof TFolder)) {
					await this.app.vault.createFolder(folderPath);
				}
				itemPath = folderPath + '/' + itemPath;
			}

			// Create the item if it doesn't already exist.
			const item = this.app.vault.getAbstractFileByPath(itemPath);
			if (!(item && item instanceof TFile)) {
				var lines = [];
				for (let key in reference) {
					// We'll deal with authors separately.
					if (key == 'authors') {
						continue;
					}
					var value: any = reference[value];
					if (LINKED_FIELDS.contains(key)) {
						value = `[[${value}]]`;
					}
					lines.push(`  ${key} = { ${value} },`);
				}
				await this.app.vault.create(itemPath, `^^^\n${formatReference(reference, true)}\n^^^`);
			}
		})();
	}
}

class BibliographySettingTab extends PluginSettingTab {
	plugin: BibliographyPlugin;

	constructor(app: App, plugin: BibliographyPlugin) {
		super(app, plugin);
		this.plugin = plugin;
	}

	display(): void {
		let { containerEl } = this;

		containerEl.empty();

		new Setting(containerEl)
			.setName('Bibliography folder')
			.setDesc('Folder in which to store references')
			.addText(text => text
				.setPlaceholder('Enter your secret')
				.setValue(this.plugin.settings.bibliographyFolder)
				.onChange(async (value) => {
					this.plugin.settings.bibliographyFolder = value;
					await this.plugin.saveSettings();
				}));
	}
}
