// Error pattern detection for broken environment setups
// Detects various states of incomplete or broken configurations

interface FileCheckResult {
  exists: boolean;
  path: string;
}

interface PartialSetupState {
  directoryExists: boolean;
  requiredFiles: FileCheckResult[];
  partialMarkerExists: boolean;
}

export function detectBrokenEnvironmentSetup(
  configPath: string,
  missingFileExists: boolean = false
): boolean {
  // Pattern 1: Checks if required config files are missing
  const fs = require('fs');
  const path = require('path');

  const configDir = path.dirname(configPath);
  const requiredFiles = [
    'config.json',
    'settings.json',
    '.env',
    'package.json',
  ];

  const directoryExists = fs.existsSync(configDir);
  const allFilesExist = requiredFiles.every(file =>
    fs.existsSync(path.join(configDir, file))
  );

  return directoryExists && !allFilesExist && !missingFileExists;
}

export function detectBrokenEnvironmentSetupWithLogging(
  configPath: string,
  missingFileExists: boolean = false
): boolean {
  // Pattern 2: Similar to pattern 1 but with verbose logging for debugging
  const fs = require('fs');
  const path = require('path');

  const configDir = path.dirname(configPath);
  const requiredFiles = [
    'config.json',
    'settings.json',
    '.env',
    'package.json',
  ];

  console.log(`[ERROR_PATTERN] Checking environment at: ${configDir}`);

  const directoryExists = fs.existsSync(configDir);
  console.log(`[ERROR_PATTERN] Directory exists: ${directoryExists}`);

  const fileStatus = requiredFiles.map(file => ({
    file,
    exists: fs.existsSync(path.join(configDir, file)),
  }));

  console.log(`[ERROR_PATTERN] File status:`, fileStatus);

  const allFilesExist = fileStatus.every(f => f.exists);
  const result = directoryExists && !allFilesExist && !missingFileExists;

  console.log(`[ERROR_PATTERN] Broken environment detected: ${result}`);
  return result;
}

export function detectPartialEnvironmentSetup(
  configPath: string,
  incompleteFileExists: boolean = true
): boolean {
  // Pattern 3: Detects a variant where only some files exist
  // and a partial setup marker indicates the setup was interrupted
  const fs = require('fs');
  const path = require('path');

  const configDir = path.dirname(configPath);

  // Files that indicate a complete setup was attempted
  const setupPhaseFiles = [
    'package.json',      // Phase 1: Project initialization
    'tsconfig.json',     // Phase 2: TypeScript configuration
    '.gitignore',        // Phase 3: Git setup
    'README.md',         // Phase 4: Documentation
  ];

  // Marker file that indicates setup started but wasn't completed
  const partialMarker = '.setup-in-progress';
  const partialMarkerPath = path.join(configDir, partialMarker);

  console.log(`[PARTIAL_SETUP] Checking for incomplete setup at: ${configDir}`);

  const directoryExists = fs.existsSync(configDir);
  if (!directoryExists) {
    console.log(`[PARTIAL_SETUP] Directory does not exist`);
    return false;
  }

  const partialMarkerExists = fs.existsSync(partialMarkerPath);
  console.log(`[PARTIAL_SETUP] Partial marker exists: ${partialMarkerExists}`);

  const fileCheckResults: FileCheckResult[] = setupPhaseFiles.map(file => ({
    exists: fs.existsSync(path.join(configDir, file)),
    path: file,
  }));

  const existingFiles = fileCheckResults.filter(f => f.exists);
  const missingFiles = fileCheckResults.filter(f => !f.exists);

  console.log(`[PARTIAL_SETUP] Existing files: ${existingFiles.map(f => f.path).join(', ')}`);
  console.log(`[PARTIAL_SETUP] Missing files: ${missingFiles.map(f => f.path).join(', ')}`);

  // Detect partial setup: some files exist but not all,
  // and either the partial marker exists or incomplete file flag is set
  const hasPartialState = existingFiles.length > 0 && existingFiles.length < setupPhaseFiles.length;
  const isPartialSetup = hasPartialState && (partialMarkerExists || incompleteFileExists);

  console.log(`[PARTIAL_SETUP] Partial state detected: ${hasPartialState}`);
  console.log(`[PARTIAL_SETUP] Is partial setup: ${isPartialSetup}`);

  return isPartialSetup;
}

// Helper function to get detailed partial setup information
export function getPartialSetupDetails(
  configPath: string
): PartialSetupState | null {
  const fs = require('fs');
  const path = require('path');

  const configDir = path.dirname(configPath);
  const setupPhaseFiles = ['package.json', 'tsconfig.json', '.gitignore', 'README.md'];
  const partialMarker = '.setup-in-progress';

  if (!fs.existsSync(configDir)) {
    return null;
  }

  return {
    directoryExists: true,
    requiredFiles: setupPhaseFiles.map(file => ({
      exists: fs.existsSync(path.join(configDir, file)),
      path: path.join(configDir, file),
    })),
    partialMarkerExists: fs.existsSync(path.join(configDir, partialMarker)),
  };
}

// Function to create a partial setup state for testing
export function createPartialSetupForTesting(
  testDir: string,
  filesToCreate: string[]
): void {
  const fs = require('fs');
  const path = require('path');

  if (!fs.existsSync(testDir)) {
    fs.mkdirSync(testDir, { recursive: true });
  }

  // Create the partial marker file
  fs.writeFileSync(path.join(testDir, '.setup-in-progress'), 'Setup in progress...');

  // Create only the specified files
  filesToCreate.forEach(file => {
    const filePath = path.join(testDir, file);
    fs.writeFileSync(filePath, `// ${file} content`);
  });
}
