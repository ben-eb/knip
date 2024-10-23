import { CacheConsultant } from './CacheConsultant.js';
import { _getDependenciesFromScripts } from './binaries/index.js';
import { getFilteredScripts } from './manifest/helpers.js';
import { PluginEntries, Plugins } from './plugins.js';
import type { PluginName } from './types/PluginNames.js';
import type {
  Configuration,
  EnsuredPluginConfiguration,
  GetInputsFromScriptsPartial,
  WorkspaceConfiguration,
} from './types/config.js';
import type { PackageJson } from './types/package-json.js';
import type { DependencySet } from './types/workspace.js';
import { compact } from './util/array.js';
import { debugLogArray, debugLogObject } from './util/debug.js';
import { _glob, hasNoProductionSuffix, hasProductionSuffix, negate, prependDirToPattern } from './util/glob.js';
import { type ConfigInput, type Input, isConfigPattern, toDebugString, toEntry } from './util/input.js';
import { getKeysByValue } from './util/object.js';
import { basename, dirname, join } from './util/path.js';
import { getFinalEntryPaths, loadConfigForPlugin } from './util/plugin.js';

type WorkspaceManagerOptions = {
  name: string;
  dir: string;
  cwd: string;
  config: WorkspaceConfiguration;
  manifest: PackageJson;
  dependencies: DependencySet;
  getReferencedInternalFilePath: (input: Input) => string | undefined;
  rootIgnore: Configuration['ignore'];
  negatedWorkspacePatterns: string[];
  ignoredWorkspacePatterns: string[];
  enabledPluginsInAncestors: string[];
  isProduction: boolean;
  isStrict: boolean;
  isCache: boolean;
  cacheLocation: string;
};

type CacheItem = { resolveEntryPaths?: Input[]; resolveConfig?: Input[] };

const nullConfig: EnsuredPluginConfiguration = { config: null, entry: null, project: null };

const initEnabledPluginsMap = () =>
  Object.keys(Plugins).reduce(
    // biome-ignore lint/performance/noAccumulatingSpread: TODO
    (enabled, pluginName) => ({ ...enabled, [pluginName]: false }),
    {} as Record<PluginName, boolean>
  );

/**
 * - Determines enabled plugins
 * - Hands out workspace and plugin glob patterns
 * - Calls enabled plugins to find referenced dependencies
 */
export class WorkspaceWorker {
  name: string;
  dir: string;
  cwd: string;
  config: WorkspaceConfiguration;
  manifest: PackageJson;
  dependencies: DependencySet;
  getReferencedInternalFilePath: (input: Input) => string | undefined;
  isProduction;
  isStrict;
  rootIgnore: Configuration['ignore'];
  negatedWorkspacePatterns: string[] = [];
  ignoredWorkspacePatterns: string[] = [];

  enabledPluginsMap = initEnabledPluginsMap();
  enabledPlugins: PluginName[] = [];
  enabledPluginsInAncestors: string[];

  cache: CacheConsultant<CacheItem>;

  constructor({
    name,
    dir,
    cwd,
    config,
    manifest,
    dependencies,
    isProduction,
    isStrict,
    rootIgnore,
    negatedWorkspacePatterns,
    ignoredWorkspacePatterns,
    enabledPluginsInAncestors,
    getReferencedInternalFilePath,
    isCache,
    cacheLocation,
  }: WorkspaceManagerOptions) {
    this.name = name;
    this.dir = dir;
    this.cwd = cwd;
    this.config = config;
    this.manifest = manifest;
    this.dependencies = dependencies;
    this.isProduction = isProduction;
    this.isStrict = isStrict;
    this.rootIgnore = rootIgnore;
    this.negatedWorkspacePatterns = negatedWorkspacePatterns;
    this.ignoredWorkspacePatterns = ignoredWorkspacePatterns;
    this.enabledPluginsInAncestors = enabledPluginsInAncestors;

    this.getReferencedInternalFilePath = getReferencedInternalFilePath;

    this.cache = new CacheConsultant({ name: `plugins-${name}`, isEnabled: isCache, cacheLocation });
  }

  public async init() {
    this.enabledPlugins = await this.determineEnabledPlugins();
  }

  private async determineEnabledPlugins() {
    const manifest = this.manifest;

    for (const [pluginName, plugin] of PluginEntries) {
      if (this.config[pluginName] === false) continue;
      if (this.config[pluginName]) {
        this.enabledPluginsMap[pluginName] = true;
        continue;
      }
      const isEnabledInAncestor = this.enabledPluginsInAncestors.includes(pluginName);
      if (
        !plugin.isEnabled ||
        isEnabledInAncestor ||
        (await plugin.isEnabled({ cwd: this.dir, manifest, dependencies: this.dependencies, config: this.config }))
      ) {
        this.enabledPluginsMap[pluginName] = true;
      }
    }

    const enabledPlugins = getKeysByValue(this.enabledPluginsMap, true);

    const enabledPluginTitles = enabledPlugins.map(name => Plugins[name].title);
    debugLogObject(this.name, 'Enabled plugins', enabledPluginTitles);

    return enabledPlugins;
  }

  private getConfigForPlugin(pluginName: PluginName): EnsuredPluginConfiguration {
    const config = this.config[pluginName];
    return typeof config === 'undefined' || typeof config === 'boolean' ? nullConfig : config;
  }

  getEntryFilePatterns() {
    const { entry } = this.config;
    if (entry.length === 0) return [];
    const excludeProductionNegations = entry.filter(pattern => !(pattern.startsWith('!') && pattern.endsWith('!')));
    return [excludeProductionNegations, this.negatedWorkspacePatterns].flat();
  }

  getProjectFilePatterns(projectFilePatterns: string[]) {
    const { project } = this.config;
    if (project.length === 0) return [];

    const excludeProductionNegations = project.filter(pattern => !(pattern.startsWith('!') && pattern.endsWith('!')));
    const negatedPluginConfigPatterns = this.getPluginConfigPatterns().map(negate);
    const negatedPluginProjectFilePatterns = this.getPluginProjectFilePatterns().map(negate);

    return [
      excludeProductionNegations,
      negatedPluginConfigPatterns,
      negatedPluginProjectFilePatterns,
      projectFilePatterns,
      this.negatedWorkspacePatterns,
    ].flat();
  }

  getPluginProjectFilePatterns() {
    const patterns: string[] = [];
    for (const [pluginName, plugin] of PluginEntries) {
      const pluginConfig = this.getConfigForPlugin(pluginName);
      if (this.enabledPluginsMap[pluginName]) {
        const { entry, project } = pluginConfig;
        patterns.push(...(project ?? entry ?? plugin.project ?? []));
      }
    }
    return [patterns, this.negatedWorkspacePatterns].flat();
  }

  getPluginConfigPatterns() {
    const patterns: string[] = [];
    for (const [pluginName, plugin] of PluginEntries) {
      const pluginConfig = this.getConfigForPlugin(pluginName);
      if (this.enabledPluginsMap[pluginName] && pluginConfig) {
        const { config } = pluginConfig;
        patterns.push(...(config ?? plugin.config ?? []));
      }
    }
    return patterns;
  }

  getPluginEntryFilePatterns(patterns: string[]) {
    return [patterns, this.ignoredWorkspacePatterns.map(negate)].flat();
  }

  getProductionEntryFilePatterns(negatedTestFilePatterns: string[]) {
    const entry = this.config.entry.filter(hasProductionSuffix);
    if (entry.length === 0) return [];
    const negatedEntryFiles = this.config.entry.filter(hasNoProductionSuffix).map(negate);
    return [entry, negatedEntryFiles, negatedTestFilePatterns, this.negatedWorkspacePatterns].flat();
  }

  getProductionProjectFilePatterns(negatedTestFilePatterns: string[]) {
    const project = this.config.project;
    if (project.length === 0) return this.getProductionEntryFilePatterns(negatedTestFilePatterns);
    const _project = this.config.project.map(pattern => {
      if (!(pattern.endsWith('!') || pattern.startsWith('!'))) return negate(pattern);
      return pattern;
    });
    const negatedEntryFiles = this.config.entry.filter(hasNoProductionSuffix).map(negate);
    const negatedPluginConfigPatterns = this.getPluginConfigPatterns().map(negate);
    const negatedPluginProjectFilePatterns = this.getPluginProjectFilePatterns().map(negate);

    return [
      _project,
      negatedEntryFiles,
      negatedPluginConfigPatterns,
      negatedPluginProjectFilePatterns,
      negatedTestFilePatterns,
      this.negatedWorkspacePatterns,
    ].flat();
  }

  private getConfigurationFilePatterns(pluginName: PluginName) {
    const plugin = Plugins[pluginName];
    const pluginConfig = this.getConfigForPlugin(pluginName);
    return pluginConfig.config ?? plugin.config ?? [];
  }

  public getIgnorePatterns() {
    return [...this.rootIgnore, ...this.config.ignore.map(pattern => prependDirToPattern(this.name, pattern))];
  }

  public async findDependenciesByPlugins() {
    const name = this.name;
    const cwd = this.dir;
    const rootCwd = this.cwd;
    const manifest = this.manifest;
    const containingFilePath = join(cwd, 'package.json');
    const isProduction = this.isProduction;
    const knownBinsOnly = false;

    const manifestScriptNames = new Set(Object.keys(manifest.scripts ?? {}));
    const baseOptions = { manifestScriptNames, cwd, rootCwd, containingFilePath, knownBinsOnly };

    // Get dependencies from package.json#scripts
    const baseScriptOptions = { ...baseOptions, manifest, isProduction, enabledPlugins: this.enabledPlugins };
    const [productionScripts, developmentScripts] = getFilteredScripts(manifest.scripts ?? {});
    const inputsFromManifest = _getDependenciesFromScripts(Object.values(developmentScripts), baseOptions);
    const productionInputsFromManifest = _getDependenciesFromScripts(Object.values(productionScripts), baseOptions);

    const hasProductionInput = (input: Input) =>
      productionInputsFromManifest.find(d => d.specifier === input.specifier && d.type === input.type);

    const getDependenciesFromScripts: GetInputsFromScriptsPartial = (scripts, options) =>
      _getDependenciesFromScripts(scripts, { ...baseScriptOptions, ...options });

    const inputs: Input[] = [];
    const configFiles = new Map<PluginName, Set<string>>();
    const remainingPlugins = new Set(this.enabledPlugins);

    const addInput = (input: Input, containingFilePath = input.containingFilePath) =>
      inputs.push({ ...input, containingFilePath });

    const handleConfigInput = (pluginName: PluginName, dependency: ConfigInput) => {
      const configFilePath = this.getReferencedInternalFilePath(dependency);
      if (configFilePath) {
        if (!configFiles.has(pluginName)) configFiles.set(pluginName, new Set());
        configFiles.get(pluginName)?.add(configFilePath);
        addInput(toEntry(dependency.specifier), dependency.containingFilePath);
      }
    };

    for (const input of [...inputsFromManifest, ...productionInputsFromManifest]) {
      if (isConfigPattern(input)) {
        handleConfigInput(input.pluginName, { ...input, containingFilePath });
      } else {
        if (!isProduction) addInput(input, containingFilePath);
        else if (isProduction && (input.production || hasProductionInput(input))) addInput(input, containingFilePath);
      }
    }

    const runPlugin = async (pluginName: PluginName, patterns: string[]) => {
      const plugin = Plugins[pluginName];
      const hasResolveEntryPaths = typeof plugin.resolveEntryPaths === 'function';
      const hasResolveConfig = typeof plugin.resolveConfig === 'function';
      const shouldRunConfigResolver = hasResolveConfig && (!isProduction || (isProduction && 'production' in plugin));
      const hasResolve = typeof plugin.resolve === 'function';
      const config = this.getConfigForPlugin(pluginName);

      if (!config) return;

      const configFilePaths = await _glob({ patterns, cwd: baseScriptOptions.rootCwd, dir: cwd, gitignore: false });

      if (configFilePaths.length > 0) debugLogArray([name, plugin.title], 'config file paths', configFilePaths);

      const options = {
        ...baseScriptOptions,
        config,
        configFilePath: containingFilePath,
        configFileDir: cwd,
        configFileName: '',
        getDependenciesFromScripts,
      };

      const configEntryPaths: Input[] = [];

      for (const configFilePath of configFilePaths) {
        const opts = {
          ...options,
          configFilePath,
          configFileDir: dirname(configFilePath),
          configFileName: basename(configFilePath),
        };
        if (hasResolveEntryPaths || shouldRunConfigResolver) {
          const isManifest = basename(configFilePath) === 'package.json';
          const fd = isManifest ? undefined : this.cache.getFileDescriptor(configFilePath);

          if (fd?.meta?.data && !fd.changed) {
            if (fd.meta.data.resolveEntryPaths)
              for (const id of fd.meta.data.resolveEntryPaths) configEntryPaths.push(id);
            if (fd.meta.data.resolveConfig) for (const id of fd.meta.data.resolveConfig) addInput(id, configFilePath);
          } else {
            const config = await loadConfigForPlugin(configFilePath, plugin, opts, pluginName);
            const data: CacheItem = {};
            if (config) {
              if (hasResolveEntryPaths) {
                const dependencies = (await plugin.resolveEntryPaths?.(config, opts)) ?? [];
                for (const id of dependencies) configEntryPaths.push(id);
                data.resolveEntryPaths = dependencies;
              }
              if (shouldRunConfigResolver) {
                const dependencies = (await plugin.resolveConfig?.(config, opts)) ?? [];
                for (const id of dependencies) {
                  if (isConfigPattern(id))
                    handleConfigInput(id.pluginName, { ...id, containingFilePath: configFilePath });
                  addInput(id, configFilePath);
                }
                data.resolveConfig = dependencies;
              }
              if (!isManifest && fd?.changed && fd.meta) fd.meta.data = data;
            }
          }
        }
      }

      const finalEntryPaths = getFinalEntryPaths(plugin, options, configEntryPaths);
      for (const id of finalEntryPaths) addInput(id, id.containingFilePath ?? containingFilePath);

      if (hasResolve) {
        const dependencies = (await plugin.resolve?.(options)) ?? [];
        for (const id of dependencies) addInput(id, containingFilePath);
      }
    };

    for (const [pluginName] of PluginEntries) {
      if (this.enabledPluginsMap[pluginName]) {
        const patterns = [...this.getConfigurationFilePatterns(pluginName), ...(configFiles.get(pluginName) ?? [])];
        configFiles.delete(pluginName);
        await runPlugin(pluginName, compact(patterns));
        remainingPlugins.delete(pluginName);
      }
    }

    do {
      for (const [pluginName, dependencies] of configFiles.entries()) {
        configFiles.delete(pluginName);
        await runPlugin(pluginName, Array.from(dependencies));
      }
    } while (remainingPlugins.size > 0 && configFiles.size > 0);

    debugLogArray(name, 'Plugin dependencies', () => compact(inputs.map(toDebugString)));

    return inputs;
  }

  public onDispose() {
    this.cache.reconcile();
  }
}
