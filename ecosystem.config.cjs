module.exports = {
  apps: [
    {
      name: 'gaon-dental',
      script: 'npx',
      args: 'wrangler pages dev dist --d1=gaon-dental-db --r2=gaon-dental-images --local --ip 0.0.0.0 --port 3000',
      env: {
        NODE_ENV: 'development',
        PORT: 3000
      },
      watch: false,
      instances: 1,
      exec_mode: 'fork'
    }
  ]
}
