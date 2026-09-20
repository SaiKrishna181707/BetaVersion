import { App } from 'aws-cdk-lib';
import { createStacks } from '../stacks';
import { loadDeploymentConfig, validationConfig } from '../config';

const app = new App();
const validation = app.node.tryGetContext('validation') === 'true';
createStacks(app, validation ? validationConfig : loadDeploymentConfig(process.env));
app.synth();
