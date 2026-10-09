import 'reflect-metadata';
import {Controller,Get,Module} from '@nestjs/common';
import {NestFactory} from '@nestjs/core';
@Controller()
class AppController {
  @Get('health') health(){return {ok:true};}
  @Get() home(){return {service:'deplo-example',message:process.env.MESSAGE??'Hello from your VPS',version:process.env.APP_VERSION??'dev'};}
}
@Module({controllers:[AppController]}) class AppModule{}
async function bootstrap(){const app=await NestFactory.create(AppModule,{logger:['error','warn']});await app.listen(Number(process.env.PORT??3000),'0.0.0.0');}
void bootstrap();
