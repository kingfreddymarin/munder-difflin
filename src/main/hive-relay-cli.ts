import { runSyntheticRelay } from './hive-relay/synthetic';

const [command, flag, ...rest] = process.argv.slice(2);
if (command === '--help' && !flag) {
  console.log('Synthetic relay: peers | delegate [--send] | prove');
} else if ((command === 'peers' || command === 'delegate' || command === 'prove') && !rest.length
  && (!flag || (command === 'delegate' && flag === '--send'))) {
  const result = runSyntheticRelay(command, flag === '--send');
  console.log(JSON.stringify(result, null, 2));
  if ('valid' in result && !result.valid) process.exitCode = 1;
} else {
  console.error('Use peers, delegate [--send], or prove. This build uses temporary synthetic floors.');
  process.exitCode = 2;
}
